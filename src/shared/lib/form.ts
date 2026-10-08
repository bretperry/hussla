/*
  Reads a text field out of FormData as a trimmed string ("" when absent or a file).
  In the app: every form that submits with FormData (add job, contacts, answers, keys).
  Used by: src/features/**.
*/
export const formText = (data: FormData, key: string): string => {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
};
