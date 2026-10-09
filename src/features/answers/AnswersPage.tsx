/*
  The answer bank: questions agents met on application forms, each with the owner's saved answer.
  In the app: "/answers"; a question with no answer pauses that application until it is filled in.
  Used by: src/app/App.tsx.
  Uses: api.listAnswers / patchAnswer / saveAnswer / deleteAnswer (delete needs a passkey tap).
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { useStats } from "@/app/stats";
import { api, describeError } from "@/shared/api";
import type { Answer } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { formatWhen } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Button } from "@/shared/ui/Button";
import { EmptyState, ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { TextArea, TextInput } from "@/shared/ui/Form";
import { PageHead, Section } from "@/shared/ui/Section";

const AnswerCard = ({ answer, onChanged }: { answer: Answer; onChanged: () => void }) => {
  const [value, setValue] = useState(answer.answer);
  const toast = useToast();
  const run = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      toast.show(message);
      onChanged();
    } catch (failure) {
      toast.show(describeError(failure));
    }
  };
  return (
    <article data-answer={answer.id} className="flex flex-col gap-2 border-t border-hairline py-4">
      <h3 className="font-display text-row font-bold">{answer.question}</h3>
      {answer.answer === "" ? <span className="kicker self-start text-accent">Needs your answer</span> : null}
      <TextArea aria-label={`Answer to: ${answer.question}`} value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={value === answer.answer} onClick={() => void run(() => api.patchAnswer(answer.id, value), "Saved")}>Save</Button>
        <Button size="sm" variant="danger" onClick={() => { if (window.confirm("Delete this question and its answer?")) void run(() => api.deleteAnswer(answer.id), "Deleted"); }}>Delete</Button>
        <span className="text-small text-muted">
          {answer.answeredAt === null ? "" : `answered ${formatWhen(answer.answeredAt)}`}
          {answer.jobIds.length === 0 ? "" : " · asked by "}
          {answer.jobIds.map((jobId, index) => (
            <span key={jobId}>{index > 0 ? ", " : ""}<Link to={`/jobs/${encodeURIComponent(jobId)}`} className="underline">{jobId}</Link></span>
          ))}
        </span>
      </div>
    </article>
  );
};

export const AnswersPage = () => {
  const answers = useResource(() => api.listAnswers(), []);
  const { refresh } = useStats();
  const toast = useToast();
  const changed = () => {
    answers.reload();
    refresh();
  };
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const question = formText(new FormData(form), "question");
    if (question === "") return;
    try {
      await api.saveAnswer(question);
      form.reset();
      changed();
    } catch (failure) {
      toast.show(describeError(failure));
    }
  };
  return (
    <>
      <PageHead kicker="Answers" title="The answer bank" />
      <p className="max-w-prose text-muted">Agents reuse these on application forms. A question with no answer pauses that application until you fill it in.</p>
      {answers.error !== null && answers.data === null ? <ErrorLine message={describeError(answers.error)} /> : null}
      {answers.data === null ? (
        answers.error === null ? <LoadingLine /> : null
      ) : (
        <Section kicker="Questions" aside={`${answers.data.length}`}>
          {answers.data.length === 0 ? <EmptyState title="No questions yet">Agents add the ones they can't answer; you can add your own below.</EmptyState> : answers.data.map((answer) => <AnswerCard key={`${answer.id}-${answer.answeredAt ?? ""}`} answer={answer} onChanged={changed} />)}
        </Section>
      )}
      <Section kicker="Add a question">
        <form onSubmit={(event) => void add(event)} className="flex gap-2">
          <TextInput name="question" aria-label="Question" placeholder="Question" required />
          <Button type="submit">Add</Button>
        </form>
      </Section>
    </>
  );
};
