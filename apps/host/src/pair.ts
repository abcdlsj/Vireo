// `npm run pair`: issues a one-time pairing code for this host. It writes to
// the host's database, so it works while the host is running.
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { Pairing, pairingInstructions } from "./pairing.js";

const config = loadConfig();
const db = Db.open(config.dataDir);
const { code } = new Pairing(db).create();
db.close();
console.log(["", ...pairingInstructions(config, code), ""].join("\n"));
