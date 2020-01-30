const geolite2 = require('geolite2');
const maxmind = require('maxmind');
const express = require('express');
const asyncHandler = require('express-async-handler')
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const app = express()
app.disable('x-powered-by');

/*
 *  Internal endpoint, proxied via nginx
 */

const hostname = 'localhost';
const port = 2222;

/*
 *  Paths to games data, as generated by update-games.sh
 */

const gamesDataPath = path.resolve(__dirname, '../data/games.json')
const gamesTestDataPath = path.resolve(__dirname, '../data/games-test.json')

/*
 *  Logging helper
 */

const logfile = path.resolve(__dirname, '../logs', path.basename(__filename, '.js') + '.log');

var errstr = function(err) {
  let obj = {};
  Object.getOwnPropertyNames(err).forEach(name => obj[name] = err[name]);
  return JSON.stringify(obj);
}

var log = function() {
  let parts = [...arguments].map(part => part instanceof Error ? errstr(part) : part);
  let msg = (new Date().toISOString()) + ' | ' + parts.join(' | ') + '\n';
  fs.appendFileSync(logfile, msg, e => {
    console.error(`error writing to log:\n  ${errstr(e)}\n  ${msg}`);
  });
}

/*
 *  Log all requests to this service
 */

var nextreqid = 1;
app.use((req, res, next) => {
  // nginx passes remote IP address in X-Real-IP header 
  // ("proxy_set_header X-Real-IP $remote_addr" in its configuration)
  req.realip = req.headers['x-real-ip'] || req.connection.remoteAddress;

  // request id for log entry correlation
  req.reqid = nextreqid++;

  log(req.reqid, 'request', req.realip, req.method, req.url, JSON.stringify(req.headers));
  next();
});

/*
 *  IP address to country code database
 */

log('info', 'maxmind database path', geolite2.paths.country);
let lookup;
try {
  data = fs.readFileSync(geolite2.paths.country);
  lookup = new maxmind.Reader(data);
} catch(e) {
  log('error', 'could not initialise maxmind reader', e);
}

/*
 *  GET https://data.airmash.online/games
 */

app.get('/', asyncHandler(async (req, res) => {
  // default country code representing an uninitialized flag
  let country = 'xx';

  // attempt IP address to country code lookup
  if (lookup) {
    try {
      let result = lookup.get(req.realip);
      if (result) {
        country = result['country']['iso_code'].toLowerCase();
        log(req.reqid, 'info', 'ip to country', req.realip, country);
      } else {
        log(req.reqid, 'info', 'ip not found in lookup', req.realip);
      }
    } catch(e) {
      log(req.reqid, 'error', 'iso_code lookup', e);
    }
  }

  // games data path depends on whether request is being made from a 
  // development copy of the frontend or not
  let gamesDataPathToRead = gamesDataPath;
  let origin = req.headers['origin'];
  let referer = req.headers['referer'];
  if (referer && referer === 'https://starmash.test.airmash.online/' || 
      origin && (
        origin === 'https://test.airmash.online' ||
        origin.startsWith('https://') && origin.endsWith('.test.airmash.online') ||
        origin === 'https://new.airmash.online' ||
        /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/m.test(origin)
      ))
  {
    gamesDataPathToRead = gamesTestDataPath;
  }

  // read games data
  let data;
  try {
    data = await fsp.readFile(gamesDataPathToRead, 'utf8');
  } catch(e) {
    try {
      // try again, possibly with a different (non-test) path
      log(req.reqid, 'error', 'could not read games data, retrying with non-test path', e);
      data = await fsp.readFile(gamesDataPath, 'utf8');
    } catch(e) {
      // status 500 returned on read error
      log(req.reqid, 'error', 'could not read games data, retry failed', e);
      return res.status(500).end();
    }
  }

  res.status(200).type('json').end(JSON.stringify({
    data,
    country,
    protocol: 5
  }));
}));

/*
 *  Default route
 */

app.use(function (req, res) {
  res.status(400).end();
});

/*
 *  Error handling
 */

app.use(function(err, req, res, next) {
  log(req.reqid, 'error', 'default handler', e);
  res.status(500).end();
});

/*
 *  Start application
 */

app.listen(port, hostname, () => {
  log('start', `server running at http://${hostname}:${port}/`);
});
