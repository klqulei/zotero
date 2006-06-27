/*
 * DB connection and schema management class
 */
Scholar.DB = new function(){
	// Private members
	var _connection;
	var _transactionRollback;
	var _transactionNestingLevel = 0;
	
	// Privileged methods
	this.query = query;
	this.valueQuery = valueQuery;
	this.rowQuery = rowQuery;
	this.columnQuery = columnQuery;
	this.statementQuery = statementQuery;
	this.getColumns = getColumns;
	this.getColumnHash = getColumnHash;
	this.beginTransaction = beginTransaction;
	this.commitTransaction = commitTransaction;
	this.rollbackTransaction = rollbackTransaction;
	this.transactionInProgress = transactionInProgress;
	this.tableExists = tableExists;
	
	/////////////////////////////////////////////////////////////////
	//
	// Privileged methods
	//
	/////////////////////////////////////////////////////////////////
	
	/*
	 * Run an SQL query
	 *
	 *  Optional _params_ is an array of bind parameters in the form
	 *		[1,"hello",3] or [{'int':2},{'string':'foobar'}]
	 *
	 * 	Returns:
	 *  	 - Associative array (similar to mysql_fetch_assoc) for SELECT's
	 *	 - lastInsertId for INSERT's
	 *	 - TRUE for other successful queries
	 *	 - FALSE on error
	 */
	function query(sql,params){
		var db = _getDBConnection();
		
		try {
			// Parse out the SQL command being used
			var op = sql.match(/^[^a-z]*[^ ]+/i);
			if (op){
				op = op.toString().toLowerCase();
			}
			
			// If SELECT statement, return result
			if (op=='select'){
				// Until the native dataset methods work (or at least exist),
				// we build a multi-dimensional associative array manually
				
				var statement = statementQuery(sql,params);
				
				var dataset = new Array();
				while (statement.executeStep()){
					var row = new Array();
					
					for(var i=0; i<statement.columnCount; i++) {
						row[statement.getColumnName(i)] = _getTypedValue(statement, i);
					}
					dataset.push(row);
				}
				statement.reset();
				
				return dataset.length ? dataset : false;
			}
			else {
				if (params){
					var statement = statementQuery(sql,params);
					statement.execute();
				}
				else {
					Scholar.debug(sql,5);
					db.executeSimpleSQL(sql);
				}
				
				if (op=='insert'){
					return db.lastInsertRowID;
				}
				// DEBUG: Can't get affected rows for UPDATE or DELETE?
				else {
					return true;
				}
			}
		}
		catch (e){
			var dberr = (db.lastErrorString!='not an error')
				? ' [ERROR: ' + db.lastErrorString + ']' : '';
			throw(e + ' [QUERY: ' + sql + ']' + dberr);
		}
	}
	
	
	/*
	 * Query a single value and return it
	 */
	function valueQuery(sql,params){
		var db = _getDBConnection();
		try {
			var statement = statementQuery(sql,params);
		}
		catch (e){
			throw(db.lastErrorString);
		}
		
		// No rows
		if (!statement.executeStep()){
			statement.reset();
			return false;
		}
		
		var value = _getTypedValue(statement, 0);
		statement.reset();
		return value;
	}
	
	
	/*
	 * Run a query and return the first row
	 */
	function rowQuery(sql,params){
		var result = query(sql,params);
		if (result){
			return result[0];
		}
	}
	
	
	/*
	 * Run a query and return the first column as a numerically-indexed array
	 */
	function columnQuery(sql,params){
		var statement = statementQuery(sql,params);
		
		if (statement){
			var column = new Array();
			while (statement.executeStep()){
				column.push(_getTypedValue(statement, 0));
			}
			statement.reset();
			return column.length ? column : false;
		}
		return false;
	}
	
	
	/*
	 * Run a query, returning a mozIStorageStatement for direct manipulation
	 *
	 *  Optional _params_ is an array of bind parameters in the form
	 *		[1,"hello",3] or [{'int':2},{'string':'foobar'}]
	 */
	function statementQuery(sql,params){
		var db = _getDBConnection();
		
		try {
			Scholar.debug(sql,5);
			var statement = db.createStatement(sql);
		}
		catch (e){
			var dberr = (db.lastErrorString!='not an error')
				? ' [ERROR: ' + db.lastErrorString + ']' : '';
			throw(e + ' [QUERY: ' + sql + ']' + dberr);
		}
		
		if (statement && params){
			for (var i=0; i<params.length; i++){
				// Integer
				if (params[i]!==null && typeof params[i]['int'] != 'undefined'){
					var type = 'int';
					var value = params[i]['int'];
				}
				// String
				else if (params[i]!==null && typeof params[i]['string'] != 'undefined'){
					var type = 'string';
					var value = params[i]['string'];
				}
				// Null
				else if (params[i]!==null && typeof params[i]['null'] != 'undefined'){
					var type = 'null';
				}
				// Automatic (trust the JS type)
				else {
					switch (typeof params[i]){
						case 'string':
							var type = 'string';
							break;
						case 'number':
							var type = 'int';
							break;
						// Object
						default:
							if (params[i]===null){
								var type = 'null';
							}
							else {
								throw('Invalid bound parameter ' + params[i]);
							}
					}
					var value = params[i];
				}
				
				// Bind the parameter as the correct type
				switch (type){
					case 'int':
						Scholar.debug('Binding parameter ' + (i+1)
							+ ' of type int: ' + value, 5);
						statement.bindInt32Parameter(i, value);
						break;
						
					case 'string':
						Scholar.debug('Binding parameter ' + (i+1)
							+ ' of type string: "' + value + '"', 5);
						statement.bindUTF8StringParameter(i, value);
						break;
						
					case 'null':
						Scholar.debug('Binding parameter ' + (i+1)
							+ ' of type NULL', 5);
						statement.bindNullParameter(i);
				}
			}
		}
		return statement;
	}
	
	
	function beginTransaction(){
		var db = _getDBConnection();
		
		if (db.transactionInProgress){
			_transactionNestingLevel++;
			Scholar.debug('Transaction in progress -- increasing level to '
				+ _transactionNestingLevel, 5);
		}
		else {
			Scholar.debug('Beginning DB transaction', 5);
			db.beginTransaction();
		}
	}
	
	
	function commitTransaction(){
		var db = _getDBConnection();
		
		if (_transactionNestingLevel){
			_transactionNestingLevel--;
			Scholar.debug('Decreasing transaction level to ' + _transactionNestingLevel, 5);
		}
		else if (_transactionRollback){
			Scholar.debug('Rolling back previously flagged transaction', 5);
			db.rollbackTransaction();
		}
		else {
			Scholar.debug('Committing transaction',5);
			try {
				db.commitTransaction();
			}
			catch(e){
				var dberr = (db.lastErrorString!='not an error')
					? ' [ERROR: ' + db.lastErrorString + ']' : '';
				throw(e + ' [QUERY: ' + sql + ']' + dberr);
			}
		}
	}
	
	
	function rollbackTransaction(){
		var db = _getDBConnection();
		
		if (_transactionNestingLevel){
			Scholar.debug('Flagging nested transaction for rollback', 5);
			_transactionRollback = true;
		}
		else {
			Scholar.debug('Rolling back transaction', 5);
			_transactionRollback = false;
			try {
				db.rollbackTransaction();
			}
			catch(e){
				var dberr = (db.lastErrorString!='not an error')
					? ' [ERROR: ' + db.lastErrorString + ']' : '';
				throw(e + ' [QUERY: ' + sql + ']' + dberr);
			}
		}
	}
	
	
	function transactionInProgress(){
		var db = _getDBConnection();
		return db.transactionInProgress;
	}
	
	
	function tableExists(table){
		return _getDBConnection().tableExists(table);
	}
	
	
	function getColumns(table){
		var db = _getDBConnection();
		
		try {
			var sql = "SELECT * FROM " + table + " LIMIT 1";
			var statement = statementQuery(sql);
			
			var cols = new Array();
			for (var i=0,len=statement.columnCount; i<len; i++){
				cols.push(statement.getColumnName(i));
			}
			return cols;
		}
		catch (e){
			Scholar.debug(e,1);
			return false;
		}
	}
	
	
	function getColumnHash(table){
		var cols = getColumns(table);
		var hash = new Array();
		if (cols.length){
			for (var i=0; i<cols.length; i++){
				hash[cols[i]] = true;
			}
		}
		return hash;
	}
	
	
	
	/////////////////////////////////////////////////////////////////
	//
	// Private methods
	//
	/////////////////////////////////////////////////////////////////
	
	/*
	 * Retrieve a link to the data store
	 */
	function _getDBConnection(){
		if (_connection){
			return _connection;
		}
		
		// Get the storage service
		var store = Components.classes["@mozilla.org/storage/service;1"].
			getService(Components.interfaces.mozIStorageService);
		
		// Get the profile directory
		var file = Components.classes["@mozilla.org/file/directory_service;1"]
			.getService(Components.interfaces.nsIProperties)
			.get("ProfD", Components.interfaces.nsIFile);
		
		// This makes file point to PROFILE_DIR/<scholar database file>
		file.append(SCHOLAR_CONFIG['DB_FILE']);
		
		_connection = store.openDatabase(file);
		
		return _connection;
	}
	
	
	function _getTypedValue(statement, i){
		var type = statement.getTypeOfIndex(i);
		switch (type){
			case statement.VALUE_TYPE_INTEGER:
				var func = statement.getInt32;
				break;
			case statement.VALUE_TYPE_TEXT:
				var func = statement.getUTF8String;
				break;
			case statement.VALUE_TYPE_NULL:
				return null;
			case statement.VALUE_TYPE_FLOAT:
				var func = statement.getDouble;
				break;
			case statement.VALUE_TYPE_BLOB:
				var func = statement.getBlob;
				break;
		}
		
		return func(i);
	}
}
