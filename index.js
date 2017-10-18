const fs = require('fs-extra');
const path = require('path');

const postcss = require('postcss');
const postcssRoot = require('postcss/lib/root');
const valueParser = require("postcss-value-parser");
const stringify = valueParser.stringify;

const postcssUrl = require('postcss-url');

const emptyNode = postcss().process('/**/').root.nodes[0];

function getImportData(node) {
  var parsedParams = valueParser(node.params).nodes,
      media = '';

  if (parsedParams.length > 2) {
    media = parsedParams.reduce((acc, val, index) => {
      if (index < 2) return acc;

      return acc + stringify(val);
    }, '');
  }
  
  return {
    path: path.resolve(path.dirname(node.source.input.file), parsedParams[0].value),
    source: node.source,
    media: media
  };
}

function processEntryStyles(styles) {
  var curIndex = 0,
      curNode = styles.nodes[curIndex],
      requiredImports = [];

  // import are allow only at the beggining file
  // so we need to loop till there is an import statement
  while(curNode && curNode.type === 'atrule' && curNode.name === 'import') {
    requiredImports.push(getImportData(curNode));
    curIndex++;
    curNode = styles.nodes[curIndex];
  }

  styles.reexportRequiredImports = requiredImports;
}

function insertStartMarker(nodes) {
  var curIndex = 0,
      curNode = nodes[curIndex],
      hasStart = false,
      requiredImports = [];

  // skip @import and :root rules
  while(curNode && ((curNode.type === 'atrule' && curNode.name === 'import') || curNode.selector === ':root')) {
    // add all import statements so we can restore them on export
    if (curNode.type === 'atrule' && curNode.name === 'import') {
      requiredImports.push(getImportData(curNode));
    }
    curIndex++;
    curNode = nodes[curIndex];
  }

  // In case if module contains only imports we need to add at least one rule
  // otherwise module will be removed and won't be able to restore imports
  if (!curNode && requiredImports.length) {
    curNode = emptyNode.clone();

    // source required to properly output module content
    curNode.source = nodes[0].source;

    nodes.push(curNode);
  }

  if (curNode) {
    curNode.reexportRequiredImports = requiredImports;

    let contentStart = postcss()
        .process('.postcss-reexport[data-type="start"]{display: none;}\n').root.nodes[0];

    // postcss-import will look for source in first node with type="media"
    contentStart.source = nodes[0].source;

    nodes.splice(curIndex, 0, contentStart);
    hasStart = true;

  }

  return hasStart;
}

function findClosingPlaceholderIndex(nodes, startIndex) {
  var endIndex = startIndex,
      curNode = nodes[endIndex];

  while(curNode.nodes[curNode.nodes.length - 1].selector !== '.postcss-reexport[data-type="end"]') {
    endIndex++;
    curNode = nodes[endIndex];
  }
  
  return endIndex;
}

function addMarkers(styles) {
  const hasStart = insertStartMarker(styles.nodes);

  if (!hasStart) return;

  let contentEnd = postcss()
      .process('.postcss-reexport[data-type="end"]{display: none;}\n').root.nodes[0];

  contentEnd.source = styles.nodes[0].source;

  styles.nodes.push(contentEnd);
}

function extractNestedMediaRules(styles, extractMediaRule) {
  var newNodes = [];

  styles.nodes.forEach((node, index) => {
    if (node.params !== extractMediaRule) {
      newNodes.push(node);
    } else {
      newNodes = newNodes.concat(node.nodes);
    }
  });
  styles.type = 'atrule';
  styles.name = 'media';
  styles.params = extractMediaRule;
  styles.nodes = newNodes;

  return styles;
}

function extractImportedBlocksRecursive(styles, options, result) {
  var extractIndexes = [];
  var curExtracIndex = {};

  options = Object.assign({
    context: './',
    tempPath: './postcss-temp'
  }, options);

  var contextPath = path.resolve(process.cwd(), options.context);
  var tempFolderPath = path.resolve(process.cwd(), options.tempPath);

  styles.nodes.forEach(function(node, index) {
    if (node.type === 'comment') return;

    if (node.type === 'atrule' && Array.isArray(node.nodes) && node.nodes.length &&  node.nodes[0].selector === '.postcss-reexport[data-type="start"]') {
      /*
        when original import has media rules
          Example: @import url('../components/gallery.css') print;
        then fist node will be media, because rules will be wrapped in 
          @media print {
            ... // content here
          }
        we need to check is first node is import placeholder start 
        and last node is import placeholder end
        we can just check length of nodes is === 1
          1. if so, 
            then we need to call extractImportedBlocksRecursive and pass node into it
          2. else
            we know that we dealing with situation where our placeholders are in
            two different nodes, start in first and end in last
            Reason for such scenario is CSS than has @media rules like this:

              .gallery-css {
                color: red;
              }
              @media screen and (max-width: 1024px) {
                .gallery-css {
                  color: blue;
                }
              }
            to solve this we just need to extract rules from @media rules inherited from import,
            to do this need to check each node, and if it's an "atrule" and has the same
            params as first item, just replace node with it's content
      */
        
      // check for case 1
      if (styles.nodes.length === 1) {
        let extractedStyles = styles.nodes.splice(index, 1)[0];

        let extractedNode = extractImportedBlocksRecursive(extractedStyles, options, result).nodes[0];

        // TODO check that entry file recieves import statements
        styles.nodes.splice(index, 0, extractedNode || emptyNode);

      // check for case 2, when it's not only import but has other rules
      } else if (node.nodes[0].selector === '.postcss-reexport[data-type="start"]' && node.nodes[node.nodes.length - 1].selector === '.postcss-reexport[data-type="end"]') {
        let extractedStyles = styles.nodes.splice(index, 1)[0];

        extractedStyles = extractNestedMediaRules(node, node.params);

        let extractedNode = extractImportedBlocksRecursive(extractedStyles, options, result).nodes[0];
        
        // TODO check that entry file recieves import statements
        styles.nodes.splice(index, 0, extractedNode || emptyNode);
      
      // check for case 2, when @import split to multiple statements
      } else {
        let endIndex = findClosingPlaceholderIndex(styles.nodes, index);

        let sliceCount = endIndex - index + 1;
        let extractedStyles = styles.nodes.splice(index, sliceCount);

        // we need to add placeholder items to preserve forEach
        // buy we add one item less because later we may need
        // to add import statement
        for (let i = 1; i < sliceCount; i++) {
          styles.nodes.splice(index, 0, emptyNode);
        }

        // fake styles, will it work?
        extractedStyles = extractNestedMediaRules({nodes: extractedStyles}, node.params);
        
        let extractedNode = extractImportedBlocksRecursive(extractedStyles, options, result).nodes[0]; 

        // TODO check that entry file recieves import statements
        styles.nodes.splice(index, 0, extractedNode || emptyNode);
      }
    } else if (node.type === 'rule') {
      if (node.selector === '.postcss-reexport[data-type="start"]') {
        curExtracIndex = {
          start: index
        };
      } else if (node.selector === '.postcss-reexport[data-type="end"]') {
        curExtracIndex.end = index;
        extractIndexes.push(curExtracIndex);
      }
    }
  });

  let offset = 0;

  extractIndexes.forEach((extracData, index) => {
    var sliceCount = extracData.end - extracData.start + 1;

    var extractedStyles = styles.nodes
      // excract previously imported block
      .splice(extracData.start - offset, sliceCount);
    
    // remove start and end placeholders
    extractedStyles = extractedStyles.splice(1, extractedStyles.length - 2);
    
    var curFile = extractedStyles[0].source.input.file;
    var contextRelativePath = path.relative(contextPath, path.dirname(curFile));
    var fileName = path.basename(curFile);
    
    // if it's import in entry file we need to replace block with @import statement
    if (extractedStyles[0].reexportRequiredImports) {
      extractedStyles[0].reexportRequiredImports.reverse().forEach(rule => {
        let contextRelativePathImport = path.relative(path.dirname(curFile), path.dirname(rule.path)).replace(/\\/g, '/');
        let contextRelativePathLocal = path.relative(contextPath, path.dirname(rule.path));
        let fileName = path.basename(rule.path);
        let node = postcss()
          .process(`@import "${contextRelativePathImport ? contextRelativePathImport + '/' : './'}${fileName}" ${rule.media}`).root.nodes[0];

        node.raws.semicolon = true;

        // only add import if import target exist
        // there can be no import target if consisted only fomr :root statement
        if (!fs.pathExistsSync(path.resolve(tempFolderPath, contextRelativePathLocal, fileName))) return;

        node.source = rule.source;
        
        extractedStyles.unshift(node);

        // styles.nodes.unshift(css.nodes[0]);
        // offset--;
      });
    }

    let extractPath = path.resolve(tempFolderPath, contextRelativePath, fileName);

    let extractedRoot = new postcssRoot();

    extractedStyles.forEach(style => {
      style.parent = null;
      extractedRoot.append(style);
    });

    // fix URLs for temp files
    extractedRoot = postcss()
      .use(postcssUrl({
        url: "rebase"
      }))
      .process(extractedRoot, {
        from: extractedStyles[0].source.input.file,
        to: extractPath,
        map: result.opts.map // use source maps setting from original config
      });

    var extractedStylesContent = extractedRoot.stringify();

    fs.outputFileSync(extractPath, extractedStylesContent.css);

    // when sourceMaps are inline or turned off
    if (extractedStylesContent.map) {
      fs.outputFileSync(extractPath + '.map', extractedStylesContent.map.toString());
    }

    offset += sliceCount;
  });

  if (styles.reexportRequiredImports) {
    styles.reexportRequiredImports.reverse().forEach(rule => {
      var contextRelativePath = path.relative(contextPath, path.dirname(rule.path));
      let fileName = path.basename(rule.path);
      let importRelativePath = path.relative(path.dirname(styles.source.input.file), path.resolve(tempFolderPath,contextRelativePath)).replace(/\\/g, '/');

      // only add import if import target exist
      // there can be no import target if consisted only fomr :root statement
      if (!fs.pathExistsSync(path.resolve(tempFolderPath, contextRelativePath, fileName))) return;

      let node = postcss()
        .process(`@import "${importRelativePath ? importRelativePath + '/' : './'}${fileName}" ${rule.media};`).root.nodes[0];

      node.source = rule.source;

      styles.prepend(node);
    });
  }

  return styles;
}

module.exports = postcss.plugin("postcss-reexport", function(options = {}) {
  return function(styles, result) {
    if (options.export) {
      extractImportedBlocksRecursive(styles, options, result);
    } else if (options.initial) {
      processEntryStyles(styles);
    } else {
      addMarkers(styles)
    }
  }
});