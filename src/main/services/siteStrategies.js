const { EconomistStrategy } = require("../sites/economist");
const { NewYorkerStrategy } = require("../sites/newyorker");
const { PulitzerStrategy } = require("../sites/pulitzer");
const { NytStrategy } = require("../sites/nyt");
const { GuardianStrategy } = require("../sites/guardian");
const { AtlanticStrategy } = require("../sites/atlantic");

const SITE_STRATEGIES = [
  EconomistStrategy,
  NewYorkerStrategy,
  PulitzerStrategy,
  NytStrategy,
  GuardianStrategy,
  AtlanticStrategy
];

function resolveSiteStrategy(url) {
  const hostname = safeHost(url);
  return SITE_STRATEGIES.find((strategy) => strategy.hostnames.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`))) || null;
}

function safeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  SITE_STRATEGIES,
  resolveSiteStrategy
};
