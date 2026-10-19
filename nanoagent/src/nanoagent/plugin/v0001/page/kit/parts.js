// Each type of a run's graph node and how a page shows it: nanoagent.plugin.provenance.PARTS,
// written by `python -m nanoagent.plugin.provenance`. Do not edit it here.

export const TYPES = {
  "SYSTEM_PROMPT": "system_prompt",
  "USER_MESSAGE": "user_message",
  "EARLIER_TURNS": "earlier_turns",
  "MODEL_REQUEST": "agent_reply",
  "THINKING": "thinking",
  "ASSISTANT": "assistant",
  "TOOL_CALL": "tool_call",
  "TOOL": "tool",
  "TOOL_RESULT": "tool_result",
  "RESPONSE": "agent_message",
  "TASK": "task",
  "TASK_INPUT": "task_input",
  "REFERENCE": "reference",
  "REFERENCE_OUTPUT": "reference_output",
  "DECISION": "decision",
  "TASK_OUTPUT": "task_output",
  "VERIFIER": "verifier",
  "VERDICT": "verdict"
};

export const PARTS = {
  "system_prompt": {
    "label": "System prompt",
    "chat": "line",
    "shape": "tile",
    "call": false,
    "made_by": [],
    "fold": null,
    "hue": "quiet",
    "font": "plain",
    "once": true,
    "repeats": false,
    "verdict": false
  },
  "user_message": {
    "label": "User message",
    "chat": "whole",
    "shape": "tile",
    "call": false,
    "made_by": [],
    "fold": null,
    "hue": "user",
    "font": "typed",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "earlier_turns": {
    "label": "Earlier turns",
    "chat": "hidden",
    "shape": "tile",
    "call": false,
    "made_by": [],
    "fold": null,
    "hue": "quiet",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "agent_reply": {
    "label": "Model request",
    "chat": "hidden",
    "shape": "card",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "think",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "thinking": {
    "label": "Thinking",
    "chat": "line",
    "shape": "line",
    "call": false,
    "made_by": [
      "agent_reply"
    ],
    "fold": "maker",
    "hue": "plain",
    "font": "thought",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "assistant": {
    "label": "Assistant",
    "chat": "whole",
    "shape": "line",
    "call": false,
    "made_by": [
      "agent_reply"
    ],
    "fold": "maker",
    "hue": "plain",
    "font": "prose",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "tool_call": {
    "label": "Tool call",
    "chat": "line",
    "shape": "line",
    "call": false,
    "made_by": [
      "agent_reply",
      "decision"
    ],
    "fold": "user",
    "hue": "plain",
    "font": "code",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "tool": {
    "label": "Tool",
    "chat": "hidden",
    "shape": "pill",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "task",
    "font": "code",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "tool_result": {
    "label": "Tool result",
    "chat": "line",
    "shape": "line",
    "call": false,
    "made_by": [
      "tool",
      "task"
    ],
    "fold": "maker",
    "hue": "plain",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "agent_message": {
    "label": "Response",
    "chat": "whole",
    "shape": "line",
    "call": false,
    "made_by": [
      "agent_reply"
    ],
    "fold": "maker",
    "hue": "answer",
    "font": "prose",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "task": {
    "label": "Task",
    "chat": "run",
    "shape": "box",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "task",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "task_input": {
    "label": "Task input",
    "chat": "line",
    "shape": "tile",
    "call": false,
    "made_by": [],
    "fold": null,
    "hue": "plain",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "reference": {
    "label": "Reference",
    "chat": "hidden",
    "shape": "pill",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "neutral",
    "font": "code",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "reference_output": {
    "label": "Reference output",
    "chat": "line",
    "shape": "line",
    "call": false,
    "made_by": [
      "reference"
    ],
    "fold": "maker",
    "hue": "plain",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "decision": {
    "label": "Decision",
    "chat": "line",
    "shape": "pill",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "think",
    "font": "plain",
    "once": false,
    "repeats": true,
    "verdict": false
  },
  "task_output": {
    "label": "Task output",
    "chat": "line",
    "shape": "tile",
    "call": false,
    "made_by": [
      "agent_reply",
      "decision",
      "tool"
    ],
    "fold": null,
    "hue": "plain",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "verifier": {
    "label": "Verifier",
    "chat": "hidden",
    "shape": "pill",
    "call": true,
    "made_by": [],
    "fold": null,
    "hue": "check",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": false
  },
  "verdict": {
    "label": "Verdict",
    "chat": "line",
    "shape": "tile",
    "call": false,
    "made_by": [
      "verifier"
    ],
    "fold": null,
    "hue": "plain",
    "font": "plain",
    "once": false,
    "repeats": false,
    "verdict": true
  }
};
