// @ts-check
import process from "node:process";
import { getSheetsClient, getTabMap, ensureTab, runBatch } from "./sheets-client.mjs";
import { CONTROL_TAB, CONTROL_LABELS, STATE } from "./control-contract.mjs";
import { loadDotEnv } from "./env.mjs";

/**
 * One-shot: create the hidden `_control` tab and seed it.
 *
 * Separate from the watcher on purpose — this uses googleapis (via
 * sheets-client.mjs) for addSheet/updateSheetProperties, and the watcher must
 * never import googleapis. Run once per spreadsheet:
 *
 *   node setup-control.mjs
 */
async function main() {
  loadDotEnv();
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!keyPath || !spreadsheetId) {
    console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_KEY and SPREADSHEET_ID are required.");
    process.exit(1);
  }

  const sheets = getSheetsClient(keyPath);
  const tabMap = await getTabMap(sheets, spreadsheetId);
  const existed = tabMap.has(CONTROL_TAB);
  const sheetId = await ensureTab(sheets, spreadsheetId, CONTROL_TAB, tabMap);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${CONTROL_TAB}'!A1:B5`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [CONTROL_LABELS[0], ""],
        [CONTROL_LABELS[1], STATE.idle],
        [CONTROL_LABELS[2], "Never run."],
        [CONTROL_LABELS[3], ""],
        [CONTROL_LABELS[4], ""],
      ],
    },
  });

  // Hidden is tidiness, not security — anyone with edit access can unhide it.
  // The token check in watch-decide.mjs is the actual defence against a stray
  // keystroke firing a sync.
  await runBatch(sheets, spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId, hidden: true },
        fields: "hidden",
      },
    },
  ]);

  console.log(`${existed ? "Reset" : "Created"} the hidden '${CONTROL_TAB}' tab.`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
