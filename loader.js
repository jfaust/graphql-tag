"use strict";

const os = require('os');
const gql = require('./src');

// Takes `source` (the source GraphQL query string)
// and `doc` (the parsed GraphQL document) and tacks on
// the imported definitions.
function expandImports(source, doc) {
  const lines = source.split(/\r\n|\r|\n/);
  let outputCode = `
    var names = {};
    function unique(defs) {
      return defs.filter(
        function(def) {
          if (def.kind !== 'FragmentDefinition') return true;
          var name = def.name.value
          if (names[name]) {
            return false;
          } else {
            names[name] = true;
            return true;
          }
        }
      )
    }
  `;

  lines.some((line) => {
    if (line[0] === '#' && line.slice(1).split(' ')[0] === 'import') {
      const importFile = line.slice(1).split(' ')[1];
      const parseDocument = `require(${importFile})`;
      const appendDef = `doc.definitions = doc.definitions.concat(unique(${parseDocument}.definitions));`;
      outputCode += appendDef + os.EOL;
    }
    return (line.length !== 0 && line[0] !== '#');
  });

  return outputCode;
}

module.exports = function(source) {
  this.cacheable();
  const doc = gql`${source}`;
  let headerCode = `
    var doc = ${JSON.stringify(doc)};
    doc.loc.source = ${JSON.stringify(doc.loc.source)};
  `;

  let outputCode = "";

  // Allow multiple query/mutation definitions in a file. This parses out dependencies
  // at compile time, and then uses those at load time to create minimal query documents
  // We cannot do the latter at compile time due to how the #import code works.
  let operationCount = doc.definitions.reduce(function(accum, op) {
    if (op.kind === "OperationDefinition") {
      return accum + 1;
    }

    return accum;
  }, 0);

  if (operationCount <= 1) {
    outputCode += `
      module.exports = doc;
    `
  } else {
    outputCode +=`
    // Collect any fragment/type references from a node, adding them to the refs Set
    function collectFragmentReferences(node, refs) {
      if (node.kind === "FragmentSpread") {
        refs.add(node.name.value);
      } else if (node.kind === "VariableDefinition") {
        const type = node.type;
        if (type.kind === "NamedType") {
          refs.add(type.name.value);
        }
      }

      if (node.selectionSet) {
        for (const selection of node.selectionSet.selections) {
          collectFragmentReferences(selection, refs);
        }
      }

      if (node.variableDefinitions) {
        for (const def of node.variableDefinitions) {
          collectFragmentReferences(def, refs);
        }
      }

      if (node.definitions) {
        for (const def of node.definitions) {
          collectFragmentReferences(def, refs);
        }
      }
    }

    const definitionRefs = {};
    (function extractReferences() {
      for (const def of doc.definitions) {
        if (def.name) {
          const refs = new Set();
          collectFragmentReferences(def, refs);
          definitionRefs[def.name.value] = refs;
        }
      }
    })();

    function findOperation(doc, name) {
      return doc.definitions.find(function(op) {
        return op.name ? op.name.value == name : false;
      });
    }
    
    function oneQuery(doc, operationName) {
      // Copy the DocumentNode, but clear out the definitions
      const newDoc = Object.assign({}, doc);

      const op = findOperation(doc, operationName);
      newDoc.definitions = [op];
      
      // Now, for the operation we're running, find any fragments referenced by
      // it or the fragments it references
      const opRefs = definitionRefs[operationName] || new Set();
      let allRefs = new Set();
      let newRefs = new Set(opRefs);
      while (newRefs.size > 0) {
        const prevRefs = newRefs;
        newRefs = new Set();

        for (let refName of prevRefs) {
          if (!allRefs.has(refName)) {
            allRefs.add(refName);
            const childRefs = definitionRefs[refName] || new Set();
            for (let childRef of childRefs) {
              newRefs.add(childRef);
            }
          }
        }
      }

      for (let refName of allRefs) {
        const op = findOperation(doc, refName);
        if (op) {
          newDoc.definitions.push(op);
        }
      }
      
      return newDoc;
    }

    module.exports = doc;
    `

    for (const op of doc.definitions) {
      if (op.kind === "OperationDefinition") {
        if (!op.name) {
          throw "Query/mutation names are required for a document with multiple definitions";
        }

        const opName = op.name.value;
        outputCode += `
        module.exports["${opName}"] = oneQuery(doc, "${opName}");
        `
      }
    }
  }

  const importOutputCode = expandImports(source, doc);
  const allCode = headerCode + os.EOL + importOutputCode + os.EOL + outputCode + os.EOL;

  return allCode;
};
