// Mock implementation of @actions/github
module.exports = {
  context: {
    actor: 'test-actor',
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    }
  },
  getOctokit: jest.fn(() => ({
    rest: {
      repos: {
        get: jest.fn()
      }
    }
  }))
};
