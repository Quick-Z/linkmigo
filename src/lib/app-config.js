const DEFAULT_APP_NAME = "LinkMigo";
const MAX_APP_NAME_LENGTH = 80;

export function getAppName() {
  return cleanAppName(process.env.LINKMIGO_APP_NAME || process.env.APP_NAME) || DEFAULT_APP_NAME;
}

function cleanAppName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_APP_NAME_LENGTH);
}
