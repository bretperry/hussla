/*
  The browser half of a passkey tap: turn the server's options into a WebAuthn assertion, as JSON.
  In the app: every owner-only button (approve, delete, create a key, settings) waits on this before it calls the API.
  Used by: src/shared/api.ts (the step-up flow).

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
