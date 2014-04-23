var express = require('express');
var path = require('path');
var fs = require('fs');
var util = require('util');
var utils = require('./utils');
var cache = require('memory-cache');
var RawGithubCache = require('./raw-github-cache').RawGithubCache;
var PrivateGithubCache = require('./private-github-cache').PrivateGithubCache;
var LocalRepoStore = require('./local-repo-store').LocalRepoStore;
var LocalCache = require('./local-cache').LocalCache;

function createApp(program) {
  var app = express();

  // LOAD CONFIG
  var configJsonPath = path.resolve(program.proxyStorageDir, 'proxy-config.json')
  var configJson = JSON.parse(fs.readFileSync(configJsonPath, { encoding: 'utf-8' }));
  var rawCache = RawGithubCache.init(program.proxyStorageDir);
  var privateCache = PrivateGithubCache.init(configJson.token,
                                             program.proxyStorageDir);

  var localRepoStore = LocalRepoStore.init(configJson['localRepos']);
  var localCache = LocalCache.init(rawCache.getCachePath(), privateCache.getCachePath());
  
  app.get('/is-component-proxy', function(req, res) {
    res.send(200, 'Ok');
  });


  /** Order of ops
   * 1) Local configured repositories
   * 2  Locally cached repositories
   * 2) Public repositories on raw.github.com
   * 3) Private github repositories
   */
  app.get('/:user/:repo/:tree/*',
    // Try local repo
    localRepoStore.middleware,

    // Try the locally cached repos
    localCache.middleware,

    // Try raw.github.com
    function(req, res, next) {
      try {
        var user = req.params.user,
          repo = req.params.repo,
          tree = req.params.tree; // Branch/tag/commit
        var repoPath = req.params[0];
        // Check the cache if the response is found here
        var isRawKey = util.format('raw:%s', req.path);
        var isRaw = cache.get(isRawKey);
        if (!isRaw && isRaw !== null) {
          return next();
        }
        var repoIsPrivateKey = util.format('privateRepo:%s:%s', user, repo);
        var repoIsPrivate = cache.get(repoIsPrivateKey);
        if (repoIsPrivate) {
          return next();
        }
        rawCache.get(user, repo, tree, repoPath, function (err, path) {
          if (err) {
            if (err.message === 'NotFound') {
              cache.put(isRawKey, false);
              // Go to the next handler
              return next();
            }
            return next(err);
          }
          cache.put(isRawKey, true);
          res.sendfile(path);
        });
      } catch(err) {
        console.log(err);
      }
    },
    // Try private repos
    function(req, res, next) {
      try {
        var user = req.params.user,
          repo = req.params.repo,
          tree = req.params.tree; // Branch/tag/commit
        var repoPath = req.params[0];
        var isPrivateKey = util.format('private:%s', req.path);
        var isPrivate = cache.get(isPrivateKey);
        if (!isPrivate && isPrivate !== null) {
          return next();
        }
        privateCache.get(user, repo, tree, repoPath)
          .then(function (path) {

            if (!fs.existsSync(path)) {
              return next();
            }

            // Make sure subsequent requests use this
            var repoIsPrivateKey = util.format('privateRepo:%s:%s', user, repo);
            cache.put(repoIsPrivateKey, true);
            cache.put(isPrivateKey, true);
            res.sendfile(path);
          })
          .catch(function error(err) {
            if (err.message === 'NotFound') {
              // Go to the next handler
              cache.put(isPrivateKey, false);
              return next();
            }
            return next(err);
          });
      } catch(err) {
        console.log(err);
      }
    },
    function(req, res) {
      res.send(404, 'File not found');
    }
  );
  return app;
}

exports.createApp = createApp;
