const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['src/main.ts'],
      bundle: true,
      platform: 'node',
      target: 'node20',
      outfile: 'lib/index.js',
      sourcemap: true,
      minify: true,
      external: [],
      // Ensure all dependencies are bundled
      packages: 'bundle',
      // Add banner to preserve license
      banner: {
        js: `// License: MIT\n// See LICENSE file for details\n`
      }
    });

    // Copy LICENSE file to lib directory
    const licenseSource = path.join(__dirname, 'LICENSE');
    const licenseTarget = path.join(__dirname, 'lib', 'LICENSE');

    if (fs.existsSync(licenseSource)) {
      fs.copyFileSync(licenseSource, licenseTarget);
    }

    console.log('Build completed successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
