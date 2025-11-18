// Setup fs constants that @actions/io needs
import constants from 'constants';
import fs from 'fs';

// Ensure fs.constants exists with all required POSIX constants
if (!fs.constants) {
  // @ts-ignore
  fs.constants = constants;
}
