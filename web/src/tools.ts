// Shipped, curated list of Claude Code tool names offered in the playbook
// "Allowed tools" picker. This is a STATIC constant, not a discovered list: the
// runner's built-in tool set is fixed by the Claude Code version baked into the
// image, not by anything the account or the wisper host advertises, so there is
// no endpoint to fetch it from. Freeform entry stays enabled at the picker, so
// custom or MCP-provided tool names still commit even though they aren't listed
// here.
export const CLAUDE_CODE_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "Task",
];

// Fixed network modes a lease can request. Kept small and explicit today; the
// picker stays freeform so future modes commit without a code change here.
export const NETWORK_MODES: readonly string[] = ["open", "none"];
