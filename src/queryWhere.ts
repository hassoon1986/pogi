import operationsMap from "./pgDbOperators";
import {FieldType} from "./pgDb";

const _ = require("lodash");
const util = require("util");

class FieldAndOperator {
    field: string;
    quotedField: string;
    operator: string;
    originalOp: string;
    mutator?: Function;
}

/** public */
function generateWhere(conditions, fieldTypes: { [index: string]: FieldType }, tableName: string, placeholderOffset = 0, skipUndefined): { where: string, params: Array<any> } {
    let result = generate({
        params: [],
        predicates: [],
        offset: placeholderOffset,
    }, conditions, fieldTypes, tableName, skipUndefined);

    return {
        where: result.predicates.length > 0 ? ' WHERE ' + result.predicates.join(' AND ') : '',
        params: result.params
    };
}

/** private */
function generate(result, conditions, fieldTypes: { [index: string]: FieldType }, tableName: string, skipUndefined) {
    _.each(conditions, (value, key) => {
        //get the column field and the operator if specified
        let fieldAndOperator = parseKey(key);

        if (value === undefined) { //null is ok, but undefined is skipped if requested
            if (skipUndefined === true) return;
            throw new Error('Invalid conditions! Field value undefined: "' + fieldAndOperator.field + '". Either delete the field, set it to null or use the options.skipUndefined parameter.');
        }
        else if (fieldAndOperator.field === 'or' || fieldAndOperator.field === 'and') {
            result = handleOrAnd(result, fieldAndOperator, value, fieldTypes, tableName, skipUndefined);
        }
        else if (value === null) {
            result = handleNullValue(result, fieldAndOperator, value);
        }
        else if (Array.isArray(value)) {
            result = handleArrayValue(result, fieldAndOperator, value, fieldTypes);
        }
        else {
            result = handleSingleValue(result, fieldAndOperator, value, fieldTypes, tableName);
        }
    });

    return result;
}

function handleOrAnd(result, fieldAndOperator, value, fieldTypes: { [index: string]: FieldType }, tableName: string, skipUndefined) {
    if (!Array.isArray(value)) {
        value = [value];
    }

    let groupResult = _.reduce(value, (acc, v) => {
        // assemble predicates for each subgroup in this 'or' array
        let subResult = generate({
            params: [],
            predicates: [],
            offset: result.params.length + acc.offset   // ensure the offset from predicates outside the subgroup is counted
        }, v, fieldTypes, tableName, skipUndefined);

        // encapsulate and join the individual predicates with AND to create the complete subgroup predicate
        acc.predicates.push(util.format('(%s)', subResult.predicates.join(' AND ')));
        acc.params = acc.params.concat(subResult.params);
        acc.offset += subResult.params.length;

        return acc;
    }, {
        params: [],
        predicates: [],
        offset: result.offset
    });

    // join the compiled subgroup predicates with OR, encapsulate, and push the
    // complex predicate ("((x = $1 AND y = $2) OR (z = $3))") onto the result object
    result.params = result.params.concat(groupResult.params);

    if (fieldAndOperator.field === 'and') {
        result.predicates.push(util.format('(%s)', groupResult.predicates.join(' AND ')));
    } else {
        result.predicates.push(util.format('(%s)', groupResult.predicates.join(' OR ')));
    }
    return result;
}

function handleNullValue(result, fieldAndOperator, value) {
    fieldAndOperator.operator = fieldAndOperator.operator === '=' ? 'IS' : 'IS NOT';
    result.predicates.push(util.format('%s %s %s', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
    return result;
}

function handleArrayValue(result, fieldAndOperator, value, fieldTypes: { [index: string]: FieldType }) {
    if (fieldAndOperator.mutator) {
        value = value.map(v => fieldAndOperator.mutator(v));
    }
    let fieldType = fieldTypes[fieldAndOperator.field];

    if (fieldType == FieldType.JSON &&
        ['?|', '?&'].indexOf(fieldAndOperator.operator) != -1) {
        result.params.push(value);
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s %s', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }
    else if (fieldType == FieldType.JSON &&
        ['@>', '<@', '&&'].indexOf(fieldAndOperator.operator) != -1) {
        result.params.push(JSON.stringify(value));
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s %s', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }
    else if ((!fieldType || fieldType == FieldType.TIME) &&
        ['=', '<>', 'IN', 'NOT IN'].includes(fieldAndOperator.operator)) {
        if (fieldAndOperator.operator === '=' || fieldAndOperator.operator === 'IN') {
            fieldAndOperator.operator = '= ANY';
        } else {
            fieldAndOperator.operator = '<> ALL';
        }

        if (value.length === 0) {  // avoid empty "[NOT] IN ()"
            throw new Error('Invalid conditions! empty array for field:"' + fieldAndOperator.field + '" and operator:"' + fieldAndOperator.operator + '"');
            //return result;
        }

        result.params.push(value
            .map(v => (fieldType == FieldType.TIME && !(value instanceof Date)) ? new Date(v) : v)
        );
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s (%s)', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }
    else if (!fieldType && ['LIKE', 'ILIKE', 'SIMILAR TO', '~', '~*'].indexOf(fieldAndOperator.operator) != -1) {
        //defaults to any
        result.params.push(value);
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s ANY(%s)', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }
    else if (!fieldType && ['NOT LIKE', 'NOT ILIKE', 'NOT SIMILAR TO', '!~', '!~*'].indexOf(fieldAndOperator.operator) != -1) {
        //defaults to all
        result.params.push(value);
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s ALL(%s)', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }
    else if (fieldType == FieldType.ARRAY &&
        ['=', '<>', '<', '>', '<=', '>=', '@>', '<@', '&&'].indexOf(fieldAndOperator.operator) != -1) {
        result.params.push(value);
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s %s', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        return result;
    }

    throw new Error('[325] Not implemented operator: "' + fieldAndOperator.operator + '" for field ' + fieldAndOperator.field + ' with type ' + fieldType);
}


function handleSingleValue(result, fieldAndOperator: FieldAndOperator, value, fieldTypes: { [index: string]: FieldType }, tableName) {
    if (fieldAndOperator.mutator) {
        value = fieldAndOperator.mutator(value);
    }
    let fieldType = fieldTypes[fieldAndOperator.field];
    if (fieldAndOperator.operator === '@@') {
        /**
         * field can be string -> to_tsquery(string)
         * or object {lang:'english', txt:string} -> to_tsquery(o.lang, o.txt)
         */
        if (typeof value == 'object') {
            if (!(value.lang || value.language) || !(value.query || value.plainquery)) {
                throw new Error('[499] only "lang"/"language" and "query/plainquery" properties are supported!');
            }
            if (fieldType == FieldType.TSVECTOR) {
                //language is already set
                result.params.push(value.lang || value.language);
                result.params.push(value.query || value.plainquery);
                let template = value.query ? "%s %s to_tsquery($%s, $%s)" : "%s %s plainto_tsquery($%s, $%s)";
                result.predicates.push(util.format(template,
                    fieldAndOperator.quotedField,
                    fieldAndOperator.operator,
                    result.params.length - 1 + result.offset, //lang
                    result.params.length + result.offset //query
                ));
            } else {
                result.params.push(value.lang || value.language);
                result.params.push(value.lang || value.language);
                result.params.push(value.query || value.plainquery);
                let template = value.query ? "to_tsvector($%s, %s) %s to_tsquery($%s, $%s)" : "to_tsvector($%s, %s) %s plainto_tsquery($%s, $%s)";
                result.predicates.push(util.format(template,
                    result.params.length - 2 + result.offset, //lang
                    fieldAndOperator.quotedField,
                    fieldAndOperator.operator,
                    result.params.length - 1 + result.offset, //lang
                    result.params.length + result.offset //query
                ));
            }
        } else {
            result.params.push(value);
            let template = fieldType == FieldType.TSVECTOR ? "%s %s plainto_tsquery($%s)" : "to_tsvector(%s) %s plainto_tsquery($%s)";
            result.predicates.push(util.format(template, fieldAndOperator.quotedField, fieldAndOperator.operator, result.params.length + result.offset));
        }
    }
    else if (fieldType == FieldType.ARRAY) {
        if (['=', '<>'].indexOf(fieldAndOperator.operator) != -1) {
            if (fieldAndOperator.originalOp == '=*') {
                result.params.push([value]);
                value = util.format("$%s", result.params.length + result.offset);
                result.predicates.push(util.format('%s && %s', fieldAndOperator.quotedField, value));
            } else {
                result.params.push(value);
                value = util.format("$%s", result.params.length + result.offset);
                result.predicates.push(util.format('%s %s ANY(%s)', value, fieldAndOperator.operator, fieldAndOperator.quotedField));
            }
        }
        else if (['LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE', 'SIMILAR TO', 'NOT SIMILAR TO'].indexOf(fieldAndOperator.operator) != -1) {
            result.params.push(value);
            value = util.format("$%s", result.params.length + result.offset);

            let q = 'EXISTS (SELECT * FROM (SELECT UNNEST(' + tableName + '.%s) _el) _arr WHERE _arr._el %s %s)';
            result.predicates.push(util.format(q, fieldAndOperator.quotedField, fieldAndOperator.operator, value));
        } else {
            throw new Error('[326] Not implemented operator: "' + fieldAndOperator.operator + '" for type ' + fieldType);
        }
    } else {
        result.params.push((fieldType == FieldType.TIME && !(value instanceof Date)) ? new Date(value) : value);
        value = util.format("$%s", result.params.length + result.offset);
        result.predicates.push(util.format('%s %s %s', fieldAndOperator.quotedField, fieldAndOperator.operator, value));
    }
    return result;
}


function strip(arr) {
    return arr.map((s) => s.trim()).filter(v => v != '');
}

function getOp(str) {
    for (let i = 0; i < str.length; i++) {
        if (operationsMap[str.substr(i)]) {
            return str.substr(i);
        }
    }
    return '';
}

/**
 * Parse out a criterion key into something more intelligible. Supports quoted
 * field names and whitespace between components. If a function is applied on the field
 * it takes the first quoted string to assume to be the column. (e.g. max("score") -> field: "score"
 * in order to be able to recognize the field type)
 *
 * 'createdTs >' => {
 *                   field:       'createdTs',
 *                   quotedField: '"createdTs"',
 *                   operator:'>',
 *                   mutator:null
 *                   }
 *
 * @param  {String} key Key in a format resembling "field [JSON operation+path] operation"
 * @return {Object}     [description]
 */
function parseKey(key): FieldAndOperator {
    key = key.trim();

    let userOp = getOp(key);
    if (userOp) {
        key = key.substr(0, key.length - userOp.length)
    }
    let operation = operationsMap[userOp] || {};
    let jsonRegexp = /(->[^>]|->>|#>[^>]|#>>)/;

    let field;
    let quotedField;

    let quotedByUser = key.indexOf('"') > -1; //key[0]=='"'; -> lets make it possible to write transformed columns, e.g. LOWER("field")
    if (quotedByUser) {
        quotedField = key;
        //field is used for find out the type of the field, so lets restore it if possible, grab the first quoted string
        field = /[^"]*"([^"]*)".*/.exec(key)[1];
        if (!quotedField || !field) {
            console.error("Parsing error!");
        }
    } else {
        let parts = strip(key.split(jsonRegexp));

        field = parts.shift();
        quotedField = util.format('"%s"', field);

        if (parts.length > 1) {
            let jsonOp = parts.shift();
            let jsonKey = parts.shift();

            // treat numeric json keys as array indices, otherwise quote it
            if (isNaN(jsonKey) && jsonKey.indexOf("'") == -1) {
                jsonKey = util.format("'%s'", jsonKey);
            }

            quotedField = util.format('%s%s%s', quotedField, jsonOp, jsonKey);
        }
    }


    if (operation.fieldMutator) {
        quotedField = operation.fieldMutator(field, quotedField);
    }


    return {
        field: field,
        quotedField: quotedField,
        operator: (operation.operator || '=').toUpperCase(),
        mutator: operation.mutator,
        originalOp: userOp
    };
}


export default generateWhere;

