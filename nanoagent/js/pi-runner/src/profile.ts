// NanoAgent's standard run profile (nanoagent.profiler.RunProfile.to_dict), recorded from PI's events
// as they happen, as nanoagent.profiler.StreamProfiler records other harnesses: a step is one model
// call and the tools it asked for; tool time is the time at least one tool runs, so tools running
// together count once.

type Usage = Record<string, number>;

interface Call {
  started: number;
  first?: number;
  ended?: number;
  usage: Usage;
  error: string | null;
}

interface Step {
  started: number;
  calls: Call[];
  tools: Record<string, unknown>[];
  toolsS: number;
}

const seconds = (from: number, to: number) => (to - from) / 1000;

function add(total: Usage, usage: Usage): void {
  for (const [name, value] of Object.entries(usage)) total[name] = (total[name] ?? 0) + value;
}

export class Profiler {
  // performance.now() counts from the process's start: the run's clock starts as PI boots.
  private readonly started = 0;
  private first?: number;
  private readonly steps: Record<string, unknown>[] = [];
  private readonly usages: Usage[] = [];
  private step?: Step;
  private readonly running = new Map<string, {name: string; started: number}>();
  private phase = 0;

  /** A model call starts, opening a step; returns the step this closed, if one was open. */
  modelStart(): Record<string, unknown> | undefined {
    const closed = this.close();
    const now = performance.now();
    this.step = {started: now, calls: [{started: now, usage: {}, error: null}], tools: [], toolsS: 0};
    return closed;
  }

  firstToken(): void {
    const call = this.call();
    if (call.first === undefined) {
      call.first = performance.now();
      this.first ??= call.first;
    }
  }

  modelEnd(usage: Usage, error: string | null): void {
    const call = this.call();
    call.ended ??= performance.now();
    call.usage = usage;
    call.error = error;
  }

  toolStart(id: string, name: string): void {
    const now = performance.now();
    if (!this.running.size) this.phase = now;
    this.running.set(id, {name, started: now});
  }

  toolEnd(id: string, isError: boolean): void {
    const tool = this.running.get(id);
    if (!tool || !this.step) throw new Error(`PI ended a tool it did not start: ${id}`);
    this.running.delete(id);
    const now = performance.now();
    this.step.tools.push({id, name: tool.name, duration_s: seconds(tool.started, now), is_error: isError, error: null});
    if (!this.running.size) this.step.toolsS += seconds(this.phase, now);
  }

  /** Close the open step, if any, and return it. */
  close(): Record<string, unknown> | undefined {
    const step = this.step;
    this.step = undefined;
    if (!step) return undefined;
    if (this.running.size) throw new Error(`a step closed with tools still running: ${[...this.running.keys()]}`);
    const ended = performance.now();
    const calls = step.calls.map((call) => {
      const end = call.ended ?? ended;
      const generation = call.first === undefined ? null : seconds(call.first, end);
      const output = call.usage.completion_tokens;
      return {
        kind: "agent",
        duration_s: seconds(call.started, end),
        ttft_s: call.first === undefined ? null : seconds(call.started, call.first),
        generation_s: generation,
        output_tokens_per_second: generation && output !== undefined ? output / generation : null,
        usage: call.usage,
        cost: 0,
        error: call.error,
      };
    });
    const usage: Usage = {};
    for (const call of calls) add(usage, call.usage);
    this.usages.push(usage);
    const modelS = calls.reduce((sum, call) => sum + call.duration_s, 0);
    const duration = seconds(step.started, ended);
    const profile = {
      step: this.steps.length + 1,
      duration_s: duration,
      model_s: modelS,
      tools_s: step.toolsS,
      overhead_s: Math.max(0, duration - modelS - step.toolsS),
      usage,
      cost: 0,
      model_calls: calls,
      tool_calls: step.tools,
    };
    this.steps.push(profile);
    return profile;
  }

  /** The run's profile, its last step closed. */
  finish(): Record<string, unknown> & {usage: Usage} {
    this.close();
    const usage: Usage = {};
    for (const one of this.usages) add(usage, one);
    const sum = (field: "model_s" | "tools_s") => this.steps.reduce((total, step) => total + (step[field] as number), 0);
    const duration = seconds(this.started, performance.now());
    const generation = this.steps.reduce(
      (total, step) => total + (step.model_calls as {generation_s: number | null}[]).reduce((part, call) => part + (call.generation_s ?? 0), 0),
      0,
    );
    return {
      duration_s: duration,
      model_s: sum("model_s"),
      tools_s: sum("tools_s"),
      overhead_s: Math.max(0, duration - sum("model_s") - sum("tools_s")),
      ttft_s: this.first === undefined ? null : seconds(this.started, this.first),
      generation_s: generation,
      usage,
      cost: 0,
      steps: this.steps,
    };
  }

  private call(): Call {
    if (!this.step) throw new Error("no model call is open");
    return this.step.calls[this.step.calls.length - 1];
  }
}
