export const AI_PROMPTS = {
  continue: (text) => `Continue writing the following text naturally:\n\n${text}`,
  rewrite: (text) => `Rewrite the following text to be clearer and more concise:\n\n${text}`,
  summarize: (text) => `Summarize the following text in 2-3 sentences:\n\n${text}`,
  explain: (text) => `Explain the following text in simple terms:\n\n${text}`,
  fix: (text) => `Fix the grammar and spelling in the following text, keeping the same meaning:\n\n${text}`,
  translate: (text) => `Translate the following text to English:\n\n${text}`,
};
