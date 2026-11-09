// Degenerate: opens the app, then claims done. For read tasks it answers
// with the value it saw while recording (a memorized answer), which must
// fail because values are randomized per session.
import { recordingPage } from "./_record.js";

export default {
  name: "say-done",
  async prepare({ task, page, reference }) {
    try {
      const answer = await reference(recordingPage(page, task.recordVars, []), task.recordVars);
      return { answer: answer ?? null };
    } catch {
      return { answer: null };
    }
  },
  async run({ page, baseUrl, artifact }) {
    await page.goto(baseUrl).catch(() => {});
    return { claimedDone: true, answer: artifact?.answer ?? null, healed: false };
  },
};
