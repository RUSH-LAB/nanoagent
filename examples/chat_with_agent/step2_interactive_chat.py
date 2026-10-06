from slimconfig import Run

from nanoagent.harness import ChatLayout
from step1_llm_inference_with_tools import ChatConfig, build, show


def ask() -> str:
    try:
        return input("you> ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return ""


class InteractiveChat(Run):
    """Continue one harness conversation until the user submits an empty line."""

    config: ChatConfig
    layout: ChatLayout

    def main(self) -> None:
        prompt = self.config.task.prompt
        with build(self.config, self.layout.workspace) as chat:
            print(f"user: {prompt.user_prompt}")
            message = prompt.user_prompt
            turns = 0
            while message:
                show(chat.send(message))
                turns += 1
                message = ask()
            self.layout.messages = chat.trajectory()
        print(f"saved {turns} turn(s) to {self.run_dir}/messages.json")


if __name__ == "__main__":
    InteractiveChat().run()
