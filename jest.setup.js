// Setup fs constants that @actions/io needs
const constants = require('constants');
const fs = require('fs');

// Ensure fs.constants exists with all required POSIX constants
if (!fs.constants) {
  fs.constants = constants;
}
