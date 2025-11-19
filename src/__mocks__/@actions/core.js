import {vi} from 'vitest';

// Mock implementation of @actions/core
export const debug = vi.fn();
export const info = vi.fn();
export const warning = vi.fn();
export const error = vi.fn();
export const setFailed = vi.fn();
export const getInput = vi.fn(() => '');
export const setOutput = vi.fn();
export const exportVariable = vi.fn();
export const setSecret = vi.fn();
export const addPath = vi.fn();
export const getState = vi.fn(() => '');
export const saveState = vi.fn();
export const group = vi.fn(async (name, fn) => fn());
export const startGroup = vi.fn();
export const endGroup = vi.fn();
export const isDebug = vi.fn(() => false);
export const summary = {
  addRaw: vi.fn(),
  addHeading: vi.fn(),
  write: vi.fn()
};
