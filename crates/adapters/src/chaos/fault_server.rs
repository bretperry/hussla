//! A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
//!
//! In the app: nothing at runtime; test support for the tier-2 (fault injection) tests.
//! Used by: `adapters/tests/note_sync_chaos.rs`.
//! Uses: `domain::note::accept_write` (the real merge rule), `app::ports` (implements `NoteRemote`).
//!
//! Not a mock of HTTP: a model of behavior. It stores notes through the same `accept_write` the
//! real far side runs, applies a write id at most once, and reads the clock the server would. So a
//! test asserts the *outcome* (what the server holds, how often a write applied), not a call count.
//! Faults are scripted by request index, so "the third request dies after the server applied it"
//! is one line, and a failing run replays exactly. A delayed request outlives a client that gives
//! up on it, as a real one does, and applies late.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app::ports::{Clock, NoteRemote, OutboxEntry, RemoteAnswer};
use domain::note::{Note, accept_write};

use super::{VirtualClock, locked};

/// Where a dropped request dies: the split that matters is whether the server applied the write first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropWhen {
    /// The connection never reached the server: nothing applied.
    BeforeApply,
    /// The server applied the write and the answer was lost on the way back.
    AfterApply,
}

/// How one request goes wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerFault {
    Drop {
        when: DropWhen,
    },
    /// The request takes `ms` in flight, then applies and answers.
    Delay {
        ms: u64,
    },
    /// A 5xx before anything is applied.
    ServerError {
        status: u16,
    },
    /// A 4xx: the server will never accept this write.
    Refused {
        status: u16,
    },
}

/// Faults by zero-based request index; `None` answers normally.
pub type FaultScript = Box<dyn Fn(usize) -> Option<ServerFault> + Send + Sync>;

#[derive(Default)]
struct State {
    notes: HashMap<String, Note>,
    seen: HashSet<String>,
    requests: usize,
    applies: usize,
    replays: usize,
}

/// The model far side. Cloning shares one server, so several devices can talk to it.
#[derive(Clone)]
pub struct FaultServer {
    state: Arc<Mutex<State>>,
    script: Arc<FaultScript>,
    clock: VirtualClock,
}

impl FaultServer {
    #[must_use]
    pub fn new(clock: VirtualClock, script: FaultScript) -> Self {
        Self {
            state: Arc::default(),
            script: Arc::new(script),
            clock,
        }
    }

    /// A server that never fails.
    #[must_use]
    pub fn healthy(clock: VirtualClock) -> Self {
        Self::new(clock, Box::new(|_| None))
    }

    /// What the server holds for a note id.
    #[must_use]
    pub fn note(&self, id: &str) -> Option<Note> {
        locked(&self.state).notes.get(id).cloned()
    }

    /// Requests received, failed ones included.
    #[must_use]
    pub fn requests(&self) -> usize {
        locked(&self.state).requests
    }

    /// Writes actually applied; a replayed write id doesn't count again.
    #[must_use]
    pub fn applies(&self) -> usize {
        locked(&self.state).applies
    }

    /// Writes that arrived again after being applied (a late request, a retry); each was a no-op.
    #[must_use]
    pub fn replays(&self) -> usize {
        locked(&self.state).replays
    }

    /// The real far side's write path: a write id applies once; the merge is the domain's.
    fn apply(&self, entry: &OutboxEntry) {
        let mut state = locked(&self.state);
        if !state.seen.insert(entry.write_id.clone()) {
            state.replays += 1;
            return;
        }
        state.applies += 1;
        let merged = accept_write(state.notes.get(&entry.note.id), entry.note.clone(), self.clock.now_ms());
        state.notes.insert(entry.note.id.clone(), merged);
    }
}

impl NoteRemote for FaultServer {
    fn put(&self, entry: &OutboxEntry) -> impl Future<Output = RemoteAnswer> + Send {
        let fault = {
            let mut state = locked(&self.state);
            state.requests += 1;
            (self.script)(state.requests - 1)
        };
        async move {
            match fault {
                None => {
                    self.apply(entry);
                    RemoteAnswer::Applied
                }
                // What the client's adapter reports when the connection drops: no answer.
                Some(ServerFault::Drop { when }) => {
                    if when == DropWhen::AfterApply {
                        self.apply(entry);
                    }
                    RemoteAnswer::Unreachable
                }
                // The request keeps going on the server after the client gives up: the apply is a task
                // of its own, so dropping this future (a client timeout) doesn't cancel it.
                Some(ServerFault::Delay { ms }) => {
                    let (server, entry) = (self.clone(), entry.clone());
                    let in_flight = tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                        server.apply(&entry);
                    });
                    // A task that died is a bug in the model; the client sees a dropped connection.
                    in_flight
                        .await
                        .map_or(RemoteAnswer::Unreachable, |()| RemoteAnswer::Applied)
                }
                // A 5xx or a 4xx: answered, nothing applied.
                Some(ServerFault::ServerError { status }) => RemoteAnswer::ServerError { status },
                Some(ServerFault::Refused { status }) => RemoteAnswer::Refused { status },
            }
        }
    }
}
