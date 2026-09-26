export interface Step {
  label: string;
  key: string;
}

export type StepState = 'done' | 'active' | 'pending' | 'error';

/** Terminal statuses map onto the last meaningful flow step. */
const TERMINAL_KEYS: Record<string, string> = {
  applied: 'ready_for_review',
  reverted: 'ready_for_review',
  rejected: 'ready_for_review',
};

const ERROR_FALLBACK: Record<string, string> = {
  error: 'waiting_for_browser',
  invalid_patch_response: 'validating_patch',
};

/**
 * Vertical status flow used by Web Handoff:
 * Preparing Context -> Waiting for Browser -> ... -> Ready for Review.
 */
export function StatusStepper({
  steps,
  current,
  error,
}: {
  steps: Step[];
  current: string | null;
  error?: string | null;
}) {
  const isError = current === 'error' || current === 'invalid_patch_response';
  const effectiveKey = current
    ? (TERMINAL_KEYS[current] ?? (isError ? ERROR_FALLBACK[current] : current))
    : null;

  let index = effectiveKey ? steps.findIndex((step) => step.key === effectiveKey) : -1;
  if (index < 0 && isError) index = 0;

  return (
    <ol className="stepper">
      {steps.map((step, stepIndex) => {
        let state: StepState = 'pending';
        if (stepIndex < index) state = 'done';
        else if (stepIndex === index) state = isError ? 'error' : 'active';

        return (
          <li key={step.key} className={`step step-${state}`}>
            <span className="step-marker" aria-hidden="true" />
            <span className="step-label">{step.label}</span>
          </li>
        );
      })}
      {isError && error ? <li className="step-error-message">{error}</li> : null}
    </ol>
  );
}

export const HANDOFF_STEPS: Step[] = [
  { key: 'context_ready', label: 'Preparing Context' },
  { key: 'waiting_for_browser', label: 'Waiting for Browser' },
  { key: 'opening_chatgpt', label: 'Opening ChatGPT' },
  { key: 'sending_prompt', label: 'Sending Prompt' },
  { key: 'waiting_for_response', label: 'Waiting for Response' },
  { key: 'receiving_response', label: 'Receiving Response' },
  { key: 'validating_patch', label: 'Validating Patch' },
  { key: 'ready_for_review', label: 'Ready for Review' },
];
