/*
  The browser half of a passkey: a tap (an assertion) and a new passkey (an attestation), both as JSON.
  In the app: every owner-only button (approve, delete, create a key, settings) waits on a tap; setup and "Add a passkey" make one.
  Used by: src/shared/api.ts (the step-up flow and passkey registration).

  The server speaks WebAuthn's JSON form (base64url strings). Current browsers convert it themselves
  (parseRequestOptionsFromJSON / toJSON); the manual path below covers the ones that don't yet.
*/

class PasskeyError extends Error {}

const toBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const fromBuffer = (buffer: ArrayBuffer | null): string | null => {
  if (buffer === null) return null;
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type JsonOptions = {
  challenge: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: AuthenticatorTransport[] }>;
  [key: string]: unknown;
};

const toRequestOptions = (json: JsonOptions): PublicKeyCredentialRequestOptions => {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  const { challenge, allowCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: toBytes(challenge),
    ...(allowCredentials === undefined
      ? {}
      : { allowCredentials: allowCredentials.map((credential) => ({ ...credential, id: toBytes(credential.id) })) }),
  };
};

const credentialToJson = (credential: PublicKeyCredential): Record<string, unknown> => {
  if (typeof credential.toJSON === "function") return { ...credential.toJSON() };
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) throw new PasskeyError("The browser returned an unexpected answer.");
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      authenticatorData: fromBuffer(response.authenticatorData),
      signature: fromBuffer(response.signature),
      userHandle: fromBuffer(response.userHandle),
    },
  };
};

// Asks the person for a passkey tap (Face ID, Touch ID, a phone) and returns the signed answer.
export const getPasskeyAssertion = async (options: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (typeof PublicKeyCredential === "undefined" || typeof navigator.credentials === "undefined") {
    throw new PasskeyError("This browser can't use a passkey here. Open Hussla on your phone or laptop.");
  }
  // The server sends {publicKey: …}; the cast is the JSON boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by the server contract
  const publicKey = (options["publicKey"] ?? options) as JsonOptions;
  try {
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(publicKey) });
    if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError("No passkey answered.");
    return credentialToJson(credential);
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new PasskeyError("The passkey prompt was cancelled or timed out. Nothing was changed.");
    }
    throw new PasskeyError("The passkey tap didn't work. Nothing was changed.");
  }
};

type JsonCreationOptions = {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  rp: PublicKeyCredentialRpEntity;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: AuthenticatorTransport[] }>;
  [key: string]: unknown;
};

const toCreationOptions = (json: JsonCreationOptions): PublicKeyCredentialCreationOptions => {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  const { challenge, user, excludeCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: toBytes(challenge),
    user: { ...user, id: toBytes(user.id) },
    ...(excludeCredentials === undefined
      ? {}
      : { excludeCredentials: excludeCredentials.map((credential) => ({ ...credential, id: toBytes(credential.id) })) }),
  };
};

const attestationToJson = (credential: PublicKeyCredential): Record<string, unknown> => {
  if (typeof credential.toJSON === "function") return { ...credential.toJSON() };
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) throw new PasskeyError("The browser returned an unexpected answer.");
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      attestationObject: fromBuffer(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
};

// Whether this browser can make or use a passkey at all (an old browser, or a page that isn't https or localhost, can't).
export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof PublicKeyCredential !== "undefined" && typeof navigator.credentials !== "undefined";

// Asks the person to make a new passkey (Face ID, Touch ID, a phone) and returns it for the server to store.
export const createPasskey = async (options: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (!passkeysSupported()) {
    throw new PasskeyError("This browser can't make a passkey here. Open Hussla's https address in Safari, Chrome or Edge.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape is fixed by the server contract
  const publicKey = (options["publicKey"] ?? options) as JsonCreationOptions;
  try {
    const credential = await navigator.credentials.create({ publicKey: toCreationOptions(publicKey) });
    if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError("No passkey was made.");
    return attestationToJson(credential);
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new PasskeyError("The passkey prompt was cancelled or timed out. Nothing was saved; try again when you're ready.");
    }
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      throw new PasskeyError("This device already has a passkey for Hussla. Use another device, or carry on.");
    }
    throw new PasskeyError("The passkey couldn't be made. Nothing was saved; try again.");
  }
};
