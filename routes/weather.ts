var http		= require( "http" ),
	SunCalc		= require( "suncalc" ),
	moment		= require( "moment-timezone" ),
	geoTZ	 	= require( "geo-tz" ),

	// Define regex filters to match against location
	filters		= {
		gps: /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/,
		pws: /^(?:pws|icao|zmw):/,
		url: /^https?:\/\/([\w\.-]+)(:\d+)?(\/.*)?$/,
		time: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})(\d{2})/,
		timezone: /^()()()()()()([+-])(\d{2})(\d{2})/
	};

/**
 * Uses the Weather Underground API to resolve a location name (ZIP code, city name, country name, etc.) to geographic
 * coordinates.
 * @param location A zip code or partial city/country name.
 * @return A promise that will be resolved with the coordinates of the best match for the specified location, or
 * rejected with an error message if unable to resolve the location.
 */
async function resolveCoordinates( location: string ): Promise< GeoCoordinates > {

	// Generate URL for autocomplete request
	const url = "http://autocomplete.wunderground.com/aq?h=0&query=" +
		encodeURIComponent( location );

	let data;
	try {
		data = await getData( url );
	} catch (err) {
		// If the request fails, indicate no data was found.
		throw "An API error occurred while attempting to resolve location";
	}

	// Check if the data is valid
	if ( typeof data.RESULTS === "object" && data.RESULTS.length && data.RESULTS[ 0 ].tz !== "MISSING" ) {

		// If it is, reply with an array containing the GPS coordinates
		return [ data.RESULTS[ 0 ].lat, data.RESULTS[ 0 ].lon ];
	} else {

		// Otherwise, indicate no data was found
		throw "Unable to resolve location";
	}
}

/**
 * Makes an HTTP GET request to the specified URL and parses the JSON response body.
 * @param url The URL to fetch.
 * @return A Promise that will be resolved the with parsed response body if the request succeeds, or will be rejected
 * with an Error if the request or JSON parsing fails.
 */
async function getData( url: string ): Promise< any > {
	try {
		const data: string = await httpRequest(url);
		return JSON.parse(data);
	} catch (err) {
		// Reject the promise if there was an error making the request or parsing the JSON.
		throw err;
	}
}

// Retrieve data from Open Weather Map for water level calculations
async function getOWMWateringData( location, callback ) {
	var OWM_API_KEY = process.env.OWM_API_KEY,
		forecastUrl = "http://api.openweathermap.org/data/2.5/forecast?appid=" + OWM_API_KEY + "&units=imperial&lat=" + location[ 0 ] + "&lon=" + location[ 1 ];

	// TODO change the type of this after defining the appropriate type
	const weather: any = getTimeData( location );

	// Perform the HTTP request to retrieve the weather data
	let forecast;
	try {
		forecast = await getData( forecastUrl );
	} catch (err) {
		// Return just the time data if retrieving the forecast fails.
		callback( weather );
		return;
	}

	// Return just the time data if the forecast data is incomplete.
	if ( !forecast || !forecast.list ) {
		callback( weather );
		return;
	}

	weather.temp = 0;
	weather.humidity = 0;
	weather.precip = 0;

	var periods = Math.min(forecast.list.length, 10);
	for ( var index = 0; index < periods; index++ ) {
		weather.temp += parseFloat( forecast.list[ index ].main.temp );
		weather.humidity += parseInt( forecast.list[ index ].main.humidity );
		weather.precip += ( forecast.list[ index ].rain ? parseFloat( forecast.list[ index ].rain[ "3h" ] || 0 ) : 0 );
	}

	weather.temp = weather.temp / periods;
	weather.humidity = weather.humidity / periods;
	weather.precip = weather.precip / 25.4;
	weather.raining = ( forecast.list[ 0 ].rain ? ( parseFloat( forecast.list[ 0 ].rain[ "3h" ] || 0 ) > 0 ) : false );

	callback( weather );
}

/**
 * Retrieves the current weather data from OWM for usage in the mobile app.
 * @param coordinates The coordinates to retrieve the weather for
 * @return A Promise that will be resolved with the OWMWeatherData if the API calls succeed, or just the TimeData if
 * an error occurs while retrieving the weather data.
 */
async function getOWMWeatherData( coordinates: GeoCoordinates ): Promise< OWMWeatherData | TimeData > {
	const OWM_API_KEY = process.env.OWM_API_KEY,
		currentUrl = "http://api.openweathermap.org/data/2.5/weather?appid=" + OWM_API_KEY + "&units=imperial&lat=" + coordinates[ 0 ] + "&lon=" + coordinates[ 1 ],
		forecastDailyUrl = "http://api.openweathermap.org/data/2.5/forecast/daily?appid=" + OWM_API_KEY + "&units=imperial&lat=" + coordinates[ 0 ] + "&lon=" + coordinates[ 1 ];

	const timeData: TimeData = getTimeData( coordinates );

	let current, forecast;
	try {
		current = await getData( currentUrl );
		forecast = await getData( forecastDailyUrl );
	} catch (err) {
		// Return just the time data if retrieving weather data fails.
		return timeData;
	}

	// Return just the time data if the weather data is incomplete.
	if ( !current || !current.main || !current.wind || !current.weather || !forecast || !forecast.list ) {
		return timeData;
	}

	const weather: OWMWeatherData = {
		...timeData,
		temp:  parseInt( current.main.temp ),
		humidity: parseInt( current.main.humidity ),
		wind: parseInt( current.wind.speed ),
		description: current.weather[0].description,
		icon: current.weather[0].icon,

		region: forecast.city.country,
		city: forecast.city.name,
		minTemp: parseInt( forecast.list[ 0 ].temp.min ),
		maxTemp: parseInt( forecast.list[ 0 ].temp.max ),
		precip: ( forecast.list[ 0 ].rain ? parseFloat( forecast.list[ 0 ].rain || 0 ) : 0 ) / 25.4,
		forecast: []
	};

	for ( let index = 0; index < forecast.list.length; index++ ) {
		weather.forecast.push( {
			temp_min: parseInt( forecast.list[ index ].temp.min ),
			temp_max: parseInt( forecast.list[ index ].temp.max ),
			date: parseInt( forecast.list[ index ].dt ),
			icon: forecast.list[ index ].weather[ 0 ].icon,
			description: forecast.list[ index ].weather[ 0 ].description
		} );
	}

	return weather;
}

/**
 * Calculates timezone and sunrise/sunset for the specified coordinates.
 * @param coordinates The coordinates to use to calculate time data.
 * @return The TimeData for the specified coordinates.
 */
function getTimeData( coordinates: GeoCoordinates ): TimeData {
	const timezone = moment().tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] ) ).utcOffset();
	const tzOffset: number = getTimezone( timezone, true );

	// Calculate sunrise and sunset since Weather Underground does not provide it
	const sunData = SunCalc.getTimes( new Date(), coordinates[ 0 ], coordinates[ 1 ] );

	sunData.sunrise.setUTCMinutes( sunData.sunrise.getUTCMinutes() + tzOffset );
	sunData.sunset.setUTCMinutes( sunData.sunset.getUTCMinutes() + tzOffset );

	return {
		timezone:	timezone,
		sunrise:	( sunData.sunrise.getUTCHours() * 60 + sunData.sunrise.getUTCMinutes() ),
		sunset:		( sunData.sunset.getUTCHours() * 60 + sunData.sunset.getUTCMinutes() )
	};
}

// Calculates the resulting water scale using the provided weather data, adjustment method and options
function calculateWeatherScale( adjustmentMethod, adjustmentOptions, weather ) {

	// Zimmerman method
	if ( adjustmentMethod === 1 ) {
		var humidityBase = 30, tempBase = 70, precipBase = 0;

		// Check to make sure valid data exists for all factors
		if ( !validateValues( [ "temp", "humidity", "precip" ], weather ) ) {
			return 100;
		}

		// Get baseline conditions for 100% water level, if provided
		if ( adjustmentOptions ) {
			humidityBase = adjustmentOptions.hasOwnProperty( "bh" ) ? adjustmentOptions.bh : humidityBase;
			tempBase = adjustmentOptions.hasOwnProperty( "bt" ) ? adjustmentOptions.bt : tempBase;
			precipBase = adjustmentOptions.hasOwnProperty( "br" ) ? adjustmentOptions.br : precipBase;
		}

		var temp = ( ( weather.maxTemp + weather.minTemp ) / 2 ) || weather.temp,
			humidityFactor = ( humidityBase - weather.humidity ),
			tempFactor = ( ( temp - tempBase ) * 4 ),
			precipFactor = ( ( precipBase - weather.precip ) * 200 );

		// Apply adjustment options, if provided, by multiplying the percentage against the factor
		if ( adjustmentOptions ) {
			if ( adjustmentOptions.hasOwnProperty( "h" ) ) {
				humidityFactor = humidityFactor * ( adjustmentOptions.h / 100 );
			}

			if ( adjustmentOptions.hasOwnProperty( "t" ) ) {
				tempFactor = tempFactor * ( adjustmentOptions.t / 100 );
			}

			if ( adjustmentOptions.hasOwnProperty( "r" ) ) {
				precipFactor = precipFactor * ( adjustmentOptions.r / 100 );
			}
		}

		// Apply all of the weather modifying factors and clamp the result between 0 and 200%.
		return Math.floor( Math.min( Math.max( 0, 100 + humidityFactor + tempFactor + precipFactor ), 200 ) );
	}

	return -1;
}

// Checks if the weather data meets any of the restrictions set by OpenSprinkler.
// Restrictions prevent any watering from occurring and are similar to 0% watering level.
//
// California watering restriction prevents watering if precipitation over two days is greater
// than 0.01" over the past 48 hours.
function checkWeatherRestriction( adjustmentValue, weather ) {

	var californiaRestriction = ( adjustmentValue >> 7 ) & 1;

	if ( californiaRestriction ) {

		// If the California watering restriction is in use then prevent watering
		// if more then 0.1" of rain has accumulated in the past 48 hours
		if ( weather.precip > 0.1 ) {
			return true;
		}
	}

	return false;
}

exports.getWeatherData = async function( req, res ) {
	var location = req.query.loc;

	if ( filters.gps.test( location ) ) {

		// Handle GPS coordinates by storing each coordinate in an array
		location = location.split( "," );
		location = [ parseFloat( location[ 0 ] ), parseFloat( location[ 1 ] ) ];

		// Continue with the weather request
		const weatherData: OWMWeatherData | TimeData = await getOWMWeatherData( location );
		res.json( {
			...weatherData,
			location: location
		} );
	} else {

		// Attempt to resolve provided location to GPS coordinates when it does not match
		// a GPS coordinate or Weather Underground location using Weather Underground autocomplete
		let coordinates: GeoCoordinates;
		try {
			coordinates = await resolveCoordinates( location );
		} catch (err) {
			res.send( "Error: Unable to resolve location" );
			return;
		}

		location = coordinates;
		const weatherData: OWMWeatherData | TimeData = await getOWMWeatherData( location );
		res.json( {
			...weatherData,
			location: location
		} );
    }
};

// API Handler when using the weatherX.py where X represents the
// adjustment method which is encoded to also carry the watering
// restriction and therefore must be decoded
exports.getWateringData = async function( req, res ) {

	// The adjustment method is encoded by the OpenSprinkler firmware and must be
	// parsed. This allows the adjustment method and the restriction type to both
	// be saved in the same byte.
	var adjustmentMethod		= req.params[ 0 ] & ~( 1 << 7 ),
		adjustmentOptions		= req.query.wto,
		location				= req.query.loc,
		outputFormat			= req.query.format,
		remoteAddress			= req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress,

		// Function that will accept the weather after it is received from the API
		// Data will be processed to retrieve the resulting scale, sunrise/sunset, timezone,
		// and also calculate if a restriction is met to prevent watering.
		finishRequest = function( weather ) {
			if ( !weather ) {
				if ( typeof location[ 0 ] === "number" && typeof location[ 1 ] === "number" ) {
					const timeData: TimeData = getTimeData( location );
					finishRequest( timeData );
				} else {
					res.send( "Error: No weather data found." );
				}

				return;
			}

			var scale = calculateWeatherScale( adjustmentMethod, adjustmentOptions, weather ),
				rainDelay = -1;

			// Check for any user-set restrictions and change the scale to 0 if the criteria is met
			if ( checkWeatherRestriction( req.params[ 0 ], weather ) ) {
				scale = 0;
			}

			// If any weather adjustment is being used, check the rain status
			if ( adjustmentMethod > 0 && weather.hasOwnProperty( "raining" ) && weather.raining ) {

				// If it is raining and the user has weather-based rain delay as the adjustment method then apply the specified delay
				if ( adjustmentMethod === 2 ) {

					rainDelay = ( adjustmentOptions && adjustmentOptions.hasOwnProperty( "d" ) ) ? adjustmentOptions.d : 24;
				} else {

					// For any other adjustment method, apply a scale of 0 (as the scale will revert when the rain stops)
					scale = 0;
				}
			}

			var data = {
					scale:		scale,
					rd:			rainDelay,
					tz:			getTimezone( weather.timezone, undefined ),
					sunrise:	weather.sunrise,
					sunset:		weather.sunset,
					eip:		ipToInt( remoteAddress ),
					rawData:    {
						h: weather.humidity,
						p: Math.round( weather.precip * 100 ) / 100,
						t: Math.round( weather.temp * 10 ) / 10,
						raining: weather.raining ? 1 : 0
					}
				};

			// Return the response to the client in the requested format
			if ( outputFormat === "json" ) {
				res.json( data );
			} else {
				res.send(	"&scale="		+	data.scale +
							"&rd="			+	data.rd +
							"&tz="			+	data.tz +
							"&sunrise="		+	data.sunrise +
							"&sunset="		+	data.sunset +
							"&eip="			+	data.eip +
							"&rawData="     +   JSON.stringify( data.rawData )
				);
			}
		};

	// Exit if no location is provided
	if ( !location ) {
		res.send( "Error: No location provided." );
		return;
	}

	// X-Forwarded-For header may contain more than one IP address and therefore
	// the string is split against a comma and the first value is selected
	remoteAddress = remoteAddress.split( "," )[ 0 ];

	// Parse weather adjustment options
	try {

		// Parse data that may be encoded
		adjustmentOptions = decodeURIComponent( adjustmentOptions.replace( /\\x/g, "%" ) );

		// Reconstruct JSON string from deformed controller output
		adjustmentOptions = JSON.parse( "{" + adjustmentOptions + "}" );
	} catch ( err ) {

		// If the JSON is not valid, do not incorporate weather adjustment options
		adjustmentOptions = false;
	}

	// Parse location string
	if ( filters.pws.test( location ) ) {

		// Weather Underground is discontinued and PWS or ICAO cannot be resolved
		res.send( "Error: Weather Underground is discontinued." );
		return;
	} else if ( filters.gps.test( location ) ) {

		// Handle GPS coordinates by storing each coordinate in an array
		location = location.split( "," );
		location = [ parseFloat( location[ 0 ] ), parseFloat( location[ 1 ] ) ];

		// Continue with the weather request
		getOWMWateringData( location, finishRequest );
	} else {

		// Attempt to resolve provided location to GPS coordinates when it does not match
		// a GPS coordinate or Weather Underground location using Weather Underground autocomplete
		let coordinates: GeoCoordinates;
		try {
			coordinates = await resolveCoordinates( location );
		} catch (err) {
			res.send("Error: Unable to resolve location");
			return;
		}

		location = coordinates;
		getOWMWateringData( location, finishRequest );
    }
};

/**
 * Makes an HTTP GET request to the specified URL and returns the response body.
 * @param url The URL to fetch.
 * @return A Promise that will be resolved the with response body if the request succeeds, or will be rejected with an
 * Error if the request fails.
 */
async function httpRequest( url: string ): Promise< string > {
	return new Promise< any >( ( resolve, reject ) => {

		const splitUrl: string[] = url.match( filters.url );

		const options = {
			host: splitUrl[ 1 ],
			port: splitUrl[ 2 ] || 80,
			path: splitUrl[ 3 ]
		};

		http.get( options, ( response ) => {
			let data = "";

			// Reassemble the data as it comes in
			response.on( "data", ( chunk ) => {
				data += chunk;
			} );

			// Once the data is completely received, resolve the promise
			response.on( "end", () => {
				resolve( data );
			} );
		} ).on( "error", ( err ) => {

			// If the HTTP request fails, reject the promise
			reject( err );
		} );
	} );
}

// Checks to make sure an array contains the keys provided and returns true or false
function validateValues( keys, array ) {
	var key;

	for ( key in keys ) {
		if ( !keys.hasOwnProperty( key ) ) {
			continue;
		}

		key = keys[ key ];

		if ( !array.hasOwnProperty( key ) || typeof array[ key ] !== "number" || isNaN( array[ key ] ) || array[ key ] === null || array[ key ] === -999 ) {
			return false;
		}
	}

	return true;
}

/**
 * Converts a timezone to an offset in minutes or OpenSprinkler encoded format.
 * @param time A time string formatted in ISO-8601 or just the timezone.
 * @param useMinutes Indicates if the returned value should be in minutes of the OpenSprinkler encoded format.
 * @return The offset of the specified timezone in either minutes or OpenSprinkler encoded format (depending on the
 * value of useMinutes).
 */
function getTimezone( time: number | string, useMinutes: boolean = false ): number {

	let hour, minute;

	if ( typeof time === "number" ) {
		hour = Math.floor( time / 60 );
		minute = time % 60;
	} else {

		// Match the provided time string against a regex for parsing
		let splitTime = time.match( filters.time ) || time.match( filters.timezone );

		hour = parseInt( splitTime[ 7 ] + splitTime[ 8 ] );
		minute = parseInt( splitTime[ 9 ] );
	}

	if ( useMinutes ) {
		return ( hour * 60 ) + minute;
	} else {

		// Convert the timezone into the OpenSprinkler encoded format
		minute = ( minute / 15 >> 0 ) / 4;
		hour = hour + ( hour >= 0 ? minute : -minute );

		return ( ( hour + 12 ) * 4 ) >> 0;
	}
}

// Converts IP string to integer
function ipToInt( ip ) {
    ip = ip.split( "." );
    return ( ( ( ( ( ( +ip[ 0 ] ) * 256 ) + ( +ip[ 1 ] ) ) * 256 ) + ( +ip[ 2 ] ) ) * 256 ) + ( +ip[ 3 ] );
}

/** Geographic coordinates. The 1st element is the latitude, and the 2nd element is the longitude. */
type GeoCoordinates = [number, number];

interface TimeData {
	/** The UTC offset, in minutes. This uses POSIX offsets, which are the negation of typically used offsets
	 * (https://github.com/eggert/tz/blob/2017b/etcetera#L36-L42).
	 */
	timezone: number;
	/** The time of sunrise, in minutes from UTC midnight. */
	sunrise: number;
	/** The time of sunset, in minutes from UTC midnight. */
	sunset: number;
}

interface OWMWeatherData extends TimeData {
	/** The current temperature (in Fahrenheit). */
	temp: number;
	/** The current humidity (as a percentage). */
	humidity: number;
	wind: number;
	description: string;
	icon: string;
	region: string;
	city: string;
	minTemp: number;
	maxTemp: number;
	precip: number;
	forecast: OWMWeatherDataForecast[]
}

interface OWMWeatherDataForecast {
	temp_min: number;
	temp_max: number;
	date: number;
	icon: string;
	description: string;
}
