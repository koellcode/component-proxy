var fs = require('fs'),
    path = require('path'),
    mkdirp = require('mkdirp');

function exists(path) {
  return fs.existsSync(path);
}

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function copyFileSync(srcFile, destFile) {
  var BUF_LENGTH, buff, bytesRead, fdr, fdw, pos;
  BUF_LENGTH = 64 * 1024;
  buff = new Buffer(BUF_LENGTH);
  fdr = fs.openSync(srcFile, "r");
  fdw = fs.openSync(destFile, "w");
  bytesRead = 1;
  pos = 0;
  while (bytesRead > 0) {
    bytesRead = fs.readSync(fdr, buff, 0, BUF_LENGTH, pos);
    fs.writeSync(fdw, buff, 0, bytesRead);
    pos += bytesRead;
  }
  fs.closeSync(fdr);
  return fs.closeSync(fdw);
};

module.exports = {
  getUserHome: getUserHome,
  ensureDir: function(path) {
    mkdirp.sync(path);
  },
  isDir: function(path) {
    if(!exists(path)) {
      return false;
    }
    var pathStats = fs.statSync(path);
    return pathStats.isDirectory();
  },
  isFile: function(path) {
    if(!exists(path)) {
      return false;
    }
    var pathStats = fs.statSync(path);
    return pathStats.isFile();
  },
  expandAndResolve: function (input) {
    // Expand if necessary
    if(input.slice(0,2) === '~/') {
      input = path.join(getUserHome(), input.slice(2));
    }
    // Resolve to an absolute path
    return path.resolve(input);
  },
  copyFileSync: copyFileSync
}

