const fs = require('fs-extra');
const path = require('path');

const postcss = require('postcss');

function insertMarkerBeforeFirstRule(nodes) {
  var curIndex = 0,
      curNode = nodes[curIndex],
      hasStart = false;

  while(curNode && (curNode.type !== 'rule' || curNode.selector === ':root')) {
    curIndex++;
    curNode = nodes[curIndex];
    continue;
  }

  if (curNode) {
    let contentStart = postcss()
        .process('.postcss-reexport[data-type="start"]{display: none;}\n').root.nodes[0];

    // postcss-import will look for source in first node with type="media"
    contentStart.source = nodes[0].source;

    nodes.splice(curIndex, 0, contentStart);
    hasStart = true;
  }

  return hasStart;
}

function addMarkers(styles) {
  const hasStart = insertMarkerBeforeFirstRule(styles.nodes);

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

function extractImportedBlocksRecursive(styles, options = { context: './', tempPath: './postcss-temp' }, parentFile = null) {
  var extractIndexes = [];
  var curExtracIndex = {};
  var stopExecution = false;

  // TODO: clear temp directory on new build?
  // FIXME: this can cause problems when we have multiple entry points
  // var tempPath = path.resolve(process.cwd(), options.tempPath);
  // fs.emptyDirSync(tempPath);
  
  styles.nodes.forEach(function(node, index) {
    if (stopExecution) return;

    if (node.type === 'comment') return;

    if (node.type === 'atrule' && node.nodes[0].selector === '.postcss-reexport[data-type="start"]') {
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

        parentFile = parentFile || extractedStyles.parent.source.input.file;
        
        let extractedNode = extractImportedBlocksRecursive(extractedStyles, options, parentFile).nodes[0];

        styles.nodes.splice(index, 0, extractedNode);

      // check for case 2, but when it's not only import but has other rules
      } else if (styles.nodes[0].type !== 'atrule') {
        let extractedStyles = styles.nodes.splice(index, 1)[0];

        extractedStyles = extractNestedMediaRules(node, node.params);

        parentFile = parentFile || extractedStyles.parent.source.input.file;

        let extractedNode = extractImportedBlocksRecursive(extractedStyles, options, parentFile).nodes[0];
        
        styles.nodes.splice(index, 0, extractedNode);
      
      // check for case 2, when @import split to multiple statements
      } else {
        let extractedStyles = extractNestedMediaRules(styles, styles.nodes[0].params);
        parentFile = parentFile || styles.source.input.file;
        extractImportedBlocksRecursive(extractedStyles, options, parentFile);
        
        // we need to shop execution, correct information for those rules
        // will be processed in other call
        stopExecution = true;
      }
      
      // extractedNode.source = parentFile;
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

      // moreve start and end placeholders
    extractedStyles = extractedStyles.splice(1, extractedStyles.length - 2);

    var curFile = extractedStyles[0].source.input.file;
    var tempFolderPath = path.resolve(process.cwd(), options.tempPath);

    parentFile = parentFile || extractedStyles[0].parent.source.input.file;

    // TODO: better solution for wrong "\" direction
    var relativePath  = path.relative(path.dirname(parentFile), tempFolderPath).replace(/\\/g, '/');
    var fileName = path.basename(curFile);

    var extractedStylesContent = extractedStyles.reduce((acc, val) => {
      return acc += val.toString();
    }, '');

    var media = styles.type === 'atrule' && styles.name === 'media' ? ' ' + styles.params : '';
    
    // TODO CSS media rule
    var css = postcss()
      .process(`@import url('${relativePath}/${fileName}')${media}`).root;

    styles.nodes.splice(index, 0, css.nodes[0]);

    fs.outputFileSync(path.resolve(process.cwd(), options.tempPath, fileName), extractedStylesContent);

    offset += (sliceCount - 1);
  });

  return styles;
}

module.exports = postcss.plugin("postcss-reexport", function(options = {}) {
  return function(styles, result) {
    if (options.isExport) {
      extractImportedBlocksRecursive(styles, options);
    } else {
      addMarkers(styles)
    }
  }
});