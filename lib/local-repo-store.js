var path = require('path');
var fs = require('fs');
var util = require('util');
var _ = require('underscore');
var debug = require('debug')('local-repo-store');

/**
 * Handles using local repository paths.
 *
 * @param localRepos
 * @constructor
 */
function LocalRepoStore(localRepos) {
  this.localRepos = localRepos || {};
  _.bindAll(this, 'middleware');
}

LocalRepoStore.init = function(localRepos) {
  return new LocalRepoStore(localRepos);
};

LocalRepoStore.prototype.middleware = function(req, res, next) {
  var user = req.params.user;
  var repo = req.params.repo;

  var repoPath = req.params[0];
  var repoKey = util.format('%s/%s', user, repo);

  // Check if there's a local repo defined, if not then continue
  var localRepo = this.localRepos[repoKey];
  if(!localRepo) {
    return next();
  }

  // Use the local repo path if it's defined
  var repoRootPath = localRepo.path;
  var filePath = path.resolve(repoRootPath, repoPath);
  if(!fs.existsSync(filePath)) {
    return res.send(404, 'File not found');
  }
  debug("Using local repository for %s/%s@%s", user, repo, repoPath);
  res.sendfile(filePath);
};

exports.LocalRepoStore = LocalRepoStore;