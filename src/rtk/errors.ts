export type RecoverableRtkError = {
  id: string;
  test(text: string): boolean;
};

export const RECOVERABLE_RTK_ERRORS: RecoverableRtkError[] = [
  {
    id: "rtk-find-unsupported-predicate",
    test: (text) =>
      /rtk(?:\:)?\s*find does not support compound predicates or actions/i.test(text) &&
      /Use `?find`? directly/i.test(text),
  },
];

export function getRecoverableRtkError(text: string): RecoverableRtkError | undefined {
  return RECOVERABLE_RTK_ERRORS.find((error) => error.test(text));
}
