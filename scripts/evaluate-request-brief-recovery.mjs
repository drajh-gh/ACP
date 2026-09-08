import { runSyntheticRecoveryExercise } from "../packages/storage/test/support/request-brief-recovery-evaluator.ts";

process.stdout.write(`${JSON.stringify(await runSyntheticRecoveryExercise(), null, 2)}\n`);
