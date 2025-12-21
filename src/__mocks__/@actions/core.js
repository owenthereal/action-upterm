// Mock implementation of @actions/core
module.exports = {
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(() => ''),
  setOutput: jest.fn(),
  exportVariable: jest.fn(),
  setSecret: jest.fn(),
  addPath: jest.fn(),
  getState: jest.fn(() => ''),
  saveState: jest.fn(),
  group: jest.fn(async (name, fn) => fn()),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  isDebug: jest.fn(() => false),
  summary: {
    addRaw: jest.fn(function () {
      return this;
    }),
    addHeading: jest.fn(function () {
      return this;
    }),
    addCodeBlock: jest.fn(function () {
      return this;
    }),
    write: jest.fn(function () {
      return Promise.resolve();
    })
  }
};
