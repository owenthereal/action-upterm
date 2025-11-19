import {vi} from 'vitest';

// Mock implementation of @actions/github
export const context = {
  actor: 'test-actor',
  repo: {
    owner: 'test-owner',
    repo: 'test-repo'
  }
};

export const getOctokit = vi.fn(() => ({
  rest: {
    repos: {
      get: vi.fn()
    }
  }
}));
