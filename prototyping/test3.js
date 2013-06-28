var PGC = require('./lib/github-utils').PrivateGithubCache;

var pgc = PGC.init("d7e5069a0617329abb0f74498d92ea7f3994c7fd", '~/.component-proxy', 120);
pgc.get('virtru', 'tdf.js', 'master', 'component.json', function(err, path) { 
  console.log("Error %s", err); 
  console.log("Res: %s", path); 
})
