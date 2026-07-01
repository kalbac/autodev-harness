// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags and starts it).
async function main(): Promise<void> {
  // TODO(Task 24): const conductor = await createConductor(...); await conductor.run();
  console.log("autodev-harness: not yet wired (P1 in progress)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
