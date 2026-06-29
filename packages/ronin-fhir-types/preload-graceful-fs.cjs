// Throttle fs.open + fs.readFile to a small concurrency cap.
// Necessary in Cowork's sandbox mount where the effective FD limit is far
// lower than /proc/self/limits reports.

const fs = require("fs");
const fsp = require("fs/promises");
const realCbReadFile = fs.readFile.bind(fs);
const realCbOpen = fs.open.bind(fs);
const realPReadFile = fsp.readFile.bind(fsp);
const realPOpen = fsp.open.bind(fsp);
const realPReaddir = fsp.readdir.bind(fsp);
const realPStat = fsp.stat.bind(fsp);

const LIMIT = parseInt(process.env.RONIN_FS_CONCURRENCY || "64", 10);
let active = 0;
const queue = [];

function dispatch() {
  while (active < LIMIT && queue.length > 0) {
    const fn = queue.shift();
    active++;
    fn().finally(() => {
      active--;
      dispatch();
    });
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    dispatch();
  });
}

// Callback-form fs
fs.readFile = (...args) => {
  const cb = args[args.length - 1];
  const params = args.slice(0, -1);
  enqueue(() => new Promise((res, rej) => {
    realCbReadFile(...params, (err, data) => err ? rej(err) : res(data));
  })).then((data) => cb(null, data), (err) => cb(err));
};
fs.open = (...args) => {
  const cb = args[args.length - 1];
  const params = args.slice(0, -1);
  enqueue(() => new Promise((res, rej) => {
    realCbOpen(...params, (err, fd) => err ? rej(err) : res(fd));
  })).then((fd) => cb(null, fd), (err) => cb(err));
};

// Promise-form fs.promises
fsp.readFile = (...params) => enqueue(() => realPReadFile(...params));
fsp.open = (...params) => enqueue(() => realPOpen(...params));
fsp.readdir = (...params) => enqueue(() => realPReaddir(...params));
fsp.stat = (...params) => enqueue(() => realPStat(...params));
