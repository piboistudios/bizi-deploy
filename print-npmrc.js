const fs = require('fs');
const contents = '' + fs.readFileSync('./.npmrc');
/// get rid of random friggin ................................................. google is inserting in auth token just to muss with me
const wtfGoogleWhyIsThisHere = contents.indexOf('.....');
if (wtfGoogleWhyIsThisHere !== -1) {
    fs.writeFileSync('./.npmrc', contents.slice(0, wtfGoogleWhyIsThisHere) + '"\r\n');
}

// print out npmrc to make sure google not still mussin wit us
console.log('' + fs.readFileSync('./.npmrc'));