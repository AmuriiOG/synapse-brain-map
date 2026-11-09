// Runs the scan off the main thread so the window never freezes.
const { parentPort, workerData } = require("node:worker_threads");
const { scan } = require("./scan");
try {
  const data = scan(workerData.configPath, (msg) => parentPort.postMessage({ progress: msg }));
  parentPort.postMessage({ data });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
