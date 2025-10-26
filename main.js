const http = require('http');
const fs = require('fs');
const path = require('path');

const port = 3000;
const host = 'localhost';

const requestListener = function(req,res) {
    res.writeHead(200);
    res.end('Hello, World!');



}