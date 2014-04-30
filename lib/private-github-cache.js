var GithubApi = require('github');
var fs = require('fs-extra');
var request = require('superagent');
var path = require('path');
var _ = require('underscore');
var util = require('util');
var utils = require('./utils');
var temp = require('temp');
var AdmZip = require('adm-zip');
var debug = require('debug')('proxy-install:private-github-cache');
var Q = require('q');
var RepoValidator = require('./repo-validator');

var defaultConnectionOptions = {
  authentication: null,
  proxyStorageDir: '~/.component-proxy'
};

var applyAuth = {
  oauth: function(req, auth) {
    return req.set('Authorization', 'token ' + auth.token);
  },
  basic: function(req, auth) {
    return req.auth(auth.username, auth.password);
  }
};

function connection(options) {
  options = _.extend({}, defaultConnectionOptions, options);

  var authentication = options.authentication;
  if(!authentication) {
    var configJSONPath = path.join(utils.expandAndResolve(options.proxyStorageDir), 'proxy-config.json');
    if(!fs.existsSync(configJSONPath)) {
      throw new Error('Authentication not provided.');
    }
    var configJSONRaw = fs.readFileSync(configJSONPath, { encoding: 'utf-8' });
    var configJSON = JSON.parse(configJSONRaw);
    authentication = {
      type: 'oauth',
      token: configJSON.token
    }
  }
  var requestMethod = function(method, url) {
    return applyAuth[authentication.type](request(method, url), authentication)
      .set('User-Agent', 'component-proxy');
  };
  return {
    get: function(url) {
      return requestMethod('GET', url)
    },
    post: function(url) {
      return request('POST', url);
    },
    method: requestMethod
  }
}

/**
 * Allows access to private github repos
 *
 * It will cache and be as good a steward as possible when it comes to rate limiting
 */
function PrivateGithubCache(oauthToken, cachePath) {
  this._oauthToken = oauthToken;
  this._cachePath = cachePath;
  this._extractedPath = path.join(this._cachePath, 'extracted');
  this._connection = connection({
    authentication: {
      token: oauthToken,
      type: "oauth"
    }
  });
}

/**
 * Initializes the Private local github cache and returns the initialized
 * object.
 *
 * @param oauthToken - The OAuth token to access Github with
 * @param storageDir - Local directory that is the root of the cache.  The directory
 * will have 'private-cache' appended to it.
 * @returns {PrivateGithubCache}
 */
PrivateGithubCache.init = function(oauthToken, storageDir) {
  var storagePath = utils.expandAndResolve(storageDir);
  var cachePath = path.join(storagePath, 'private-cache')
  // Ensure the cache path
  utils.ensureDir(cachePath);
  return new PrivateGithubCache(oauthToken, cachePath);
};

/**
 * This retrieves a file from the Github path
 *
 * @param user - Github user name
 * @param repo - Github repository path under user
 * @param tree - The branch or tag name
 * @param repoPath - The file name to retrieve
 * @returns {promise|Q.promise}
 */
PrivateGithubCache.prototype.get = function(user, repo, tree, repoPath) {

  // Check if the repo zip on the file system
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);

  // Setup the finish callback to return the path to the requested file if it exists
  var filePath = path.join(this._extractedPath, user, repo, tree, repoPath);

  if(!fs.existsSync(localPath)) {
    return this._downloadAndExtractRepoZip(filePath, user, repo, tree);
  } else {

    if (repoPath === 'component.json') {
      if (!this._validateCacheRepo(user, repo, tree)) {
        // Delete the zipball so we download it again
        fs.unlinkSync(localPath);
        return this._downloadAndExtractRepoZip(filePath, user, repo, tree);
      }
    }

    debug("Using local cache for private repo %s/%s@%s", user, repo, tree);
    return Q(filePath);
  }
};

PrivateGithubCache.prototype._validateCacheRepo = function(user, repo, tree) {
  var validator = new RepoValidator(this._extractedPath, user, repo, tree);
  var result = validator.validate();

  // For now just return true/false, later we can handle different scenarios
  return result.valid;
};


/**
 * Download and extract the repo zip
 */
PrivateGithubCache.prototype._downloadAndExtractRepoZip = function(filePath,
                                                                   user,
                                                                   repo,
                                                                   tree) {
  var self = this;
  var deferred = Q.defer();

  // TODO: add in checking the cache data
  //var cacheData = this._loadRepoCacheData(user, repo, tree);


  var githubUrl = util.format('https://api.github.com/repos/%s/%s/zipball/%s', user, repo, tree);
  var req = request.get(githubUrl)
    .redirects(0)
    .set('Authorization', 'token ' + this._oauthToken)
    .set('User-Agent', 'component-proxy');

  req.end(function(res) {
    try {
      var zipUrl = res.header['location'];
      self.downloadZip(user, repo, tree, zipUrl, deferred);
    } catch (err) {
      deferred.reject(err);
    }
  });

  return deferred.promise.then(function(){
    if(!fs.existsSync(filePath)) {
      throw new Error('NotFound');
    }
    return filePath;
  });
};

PrivateGithubCache.prototype.downloadZip = function(user, repo, tree, zipUrl, deferred) {
  var self = this;
  // Get local path
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);

  // Create a temporary filepath
  var tempPath = temp.path();
  debug("Retrieving zipball for repo `%s/%s@%s` into temp path `%s`", user, repo, tree, tempPath);
  // Create a stream for the temp file
  var tempStream = fs.createWriteStream(tempPath);

  request.get(zipUrl)
    .end(function(err, res) {
      if(err) {
        debug(err);
        return deferred.reject(err);
      }

      if (res.error) {
        debug('Error : ' + res.error);
        return deferred.reject(res.error);
      }

      var count = 0;
      res.on('data', function(chunk) {
        try {
          count += chunk.length;
          tempStream.write(chunk);
        } catch (err) {
          deferred.reject(err);
        }
      });
      res.on('end', function() {
        tempStream.on('finish', function() {
          try {

            debug("Zipball for repo `%s/%s@%s` retrieved : status `%s`", user, repo, tree, res.statusCode);
            if(res.statusCode !== 200) {
              debug("Could not access %s", zipUrl);
              // Clean up temp
              fs.unlinkSync(tempPath);
              return deferred.reject(new Error('NotFound'));
            }

            utils.ensureDir(path.dirname(localPath));
            utils.copyFileSync(tempPath, localPath);

            self._extractRepoZip(user, repo, tree, localPath, deferred);
          } catch (err) {
            deferred.reject(err);
          } finally {
            try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
          }
        });
        tempStream.end();
        tempStream.close();
      });
    });
};

PrivateGithubCache.prototype._extractRepoZip = function(user, repo, tree, zipPath, deferred) {
  var destPath = path.join(this._extractedPath, user, repo, tree);

  // if the destination exists clean it up
  if(fs.existsSync(destPath)) {
    fs.removeSync(destPath);
  }
  // Make sure it exists
  utils.ensureDir(destPath);
  var zip = new AdmZip(zipPath);
  var zipEntries = zip.getEntries();

  // Unpack the zip
  zipEntries.forEach(function(zipEntry) {
    if(zipEntry.isDirectory) {
      return;
    }
    debug('Extracting %s', zipEntry.entryName);
    var entryPath = zipEntry.entryName;
    var entrySplitPath = entryPath.split(path.sep);
    var entryRelPath = entrySplitPath.slice(1).join(path.sep);
    var entryAbsPath = path.resolve(destPath, entryRelPath);
    var entryDirPath = path.dirname(entryAbsPath);
    var entryBuffer = zipEntry.getData();

    // Make sure it's parent directories exist
    utils.ensureDir(entryDirPath);

    // Write the file to disk
    fs.writeFileSync(entryAbsPath, entryBuffer);
  });

  var validator = new RepoValidator(this._extractedPath, user, repo, tree);
  var result = validator.validate();
  if (!result.valid) {
    debug('Validation failed for downloaded repository.  Check the consistency of component.json.');
    deferred.reject(result);
  }

  deferred.resolve();
};

PrivateGithubCache.prototype.getCachePath = function() {
  return this._cachePath;
};

PrivateGithubCache.prototype._getLocalRepoZipballPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.zip', user, repo, tree));
};

PrivateGithubCache.prototype._getRepoCacheDataPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.cache', user, repo, tree));
};

PrivateGithubCache.prototype._loadRepoCacheData = function(user, repo, tree) {
  var cacheDataPath = this._getRepoCacheDataPath(user, repo, tree);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8' }));
};


exports.PrivateGithubCache = PrivateGithubCache;
