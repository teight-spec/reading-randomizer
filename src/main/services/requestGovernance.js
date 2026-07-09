const { RequestGovernor } = require("./requestGovernor");
const { classifyFailure, createTraceId } = require("./requestClassification");

function createRequestGovernance({ minIntervalMs = 1200, maxRetries = 1 } = {}) {
  const governor = new RequestGovernor({ minIntervalMs, maxRetries });
  return {
    request: (url, options = {}) => governor.request(url, options),
    classifyFailure,
    createTraceId
  };
}

module.exports = {
  createRequestGovernance,
  classifyFailure,
  createTraceId
};
