var fs = require('fs-extra');
var path = require('path');
var _ = require('underscore');
var debug = require('debug')('repo-validator');

/**
 * This class will construct a cached repository path and then
 * validate that all files exist within the repository. This
 * ensures that the cache is consistent.
 *
 * @param user
 * @param repo
 * @param tree
 * @constructor
 */
function RepoValidator(cacheDir, user, repo, tree) {
  this.cacheDir = cacheDir;
  this.user = user;
  this.repo = repo;
  this.tree = tree;
}

/**
 * Validation result object.
 *
 * @param valid
 * @param reason
 * @param info
 * @constructor
 */
function ValidationResult(valid, reason, info) {
  this.valid = valid;
  this.reason = reason;
  this.info = info;
}

RepoValidator.prototype.validate = function() {
  var repoDir = path.join(this.cacheDir, this.user, this.repo, this.tree);
  if (!fs.existsSync(repoDir)) {
    debug('Directory does not exist : ' + repoDir);
    return new ValidationResult(false, 'DirectoryNotExists', repoDir);
  }

  var componentJsonPath = path.join(repoDir, 'component.json');
  if (!fs.existsSync(componentJsonPath)) {
    debug('The file component.json does not exist in location : ' + componentJsonPath);
    return new ValidationResult(false, 'ComponentJsonNotExists', componentJsonPath);
  }

  var json = JSON.parse(fs.readFileSync(componentJsonPath, { encoding: 'utf-8' }));
  return this.validateScripts(repoDir, json.scripts);
};

/**
 * Iterates all scripts and verifies their existance.
 *
 * @param baseDir - The base directory to look in
 * @param scripts - The array of relative script paths to validate
 * @returns {ValidationResult}
 */
RepoValidator.prototype.validateScripts = function (baseDir, scripts) {
  for (var i = 0; i < scripts.length; i++) {
    var filePath = path.join(baseDir, scripts[i]);
    if (!fs.existsSync(filePath)) {
      debug('The file not exist : ' + filePath);
      return new ValidationResult(false, 'FileNotFound', filePath);
    }
  }
  return new ValidationResult(true);
};

module.exports = RepoValidator;