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
  var configJson = undefined;
  if(!fs.existsSync(configJsonPath)) {
    // default config
    configJson = {};
  }
  else {
    configJson = JSON.parse(fs.readFileSync(configJsonPath, { encoding: 'utf-8' }));
  }

  var rawCache = RawGithubCache.init(program.proxyStorageDir, cache);
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
    rawCache.middleware,

    // Try private repos
    function(req, res, next) {
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
    },
    function(req, res) {
      res.send(404, 'File not found');
    }
  );

  app.use(function(err, req, res, next){
    console.error(err);
    res.send(500, 'An internal error has occurred.');
  });

  return app;
}

exports.createApp = createApp;
