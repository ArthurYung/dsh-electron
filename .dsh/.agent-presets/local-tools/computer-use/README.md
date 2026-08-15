# Windows Computer Use tools

This preset-local Cordis plugin registers two native Harness tools:

- `computer_observe`: reads a compact Windows UI Automation tree and can save a local window screenshot.
- `computer_action`: performs one mouse, keyboard, typing, or scrolling action.

Every `computer_action` call is converted to an `ask` decision in the Harness `tools/pre-execute` pipeline. Observation stays read-only. Element refs are session-local and valid only until the next observation.

The DeepSeek official chat-completions adapter is text-only, so screenshots are saved locally and represented to the model by their path. The primary model observation is the UI Automation tree.
