export function isAlreadyRtkCommand(command: string): boolean {
  return command.trimStart().startsWith("rtk ");
}
