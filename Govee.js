import udp from "@SignalRGB/udp";
export function Name() { return "Govee"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX"; }
export function Size() { return [22, 1]; }
export function SubdeviceController() { return true; }
/* global
controller:readonly
discovery: readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
TurnOffOnShutdown:readonly
protocolSelect:readonly
blendSegments:readonly
probeEnabled:readonly
probeStrand:readonly
probeLedsPerStrand:readonly
probeLitLedsPerStrand:readonly
probePattern:readonly
probeModeByte:readonly
*/
export function ControllableParameters() {
	return [
		{property:"shutdownColor", group:"lighting", label:"Shutdown Color", description: "This color is applied to the device when the System, or SignalRGB is shutting down", min:"0", max:"360", type:"color", default:"#000000"},
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description: "Determines where the device's RGB comes from. Canvas will pull from the active Effect, while Forced will override it to a specific color", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description: "The color used when 'Forced' Lighting Mode is enabled", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"TurnOffOnShutdown", group:"settings", label:"Turn off on unlink process", description: "This turns off the device during the unlink/disabling of the device process or shutdown of the app", type:"boolean", default:"false"},
		{property:"protocolSelect", group:"settings", label:"Protocol", description: "Determines which protocol will be used to control the device. Auto picks the best protocol this device is known to support, and is the right choice unless you're troubleshooting. (Not all protocols works on a device)", type:"combobox", values:["Auto", "Dreamview", "RazerV1", "RazerV2", "Static"], default:"Auto"},
		{property:"blendSegments", group:"settings", label:"Blend Between Segments", description: "Lets the device fade between the colors we send instead of applying each one to its own segment. Auto follows what the device library says. Softer on a strip, wrong on anything built from separate physical pieces like a curtain, where it blends across a gap that is not there in the light.", type:"combobox", values:["Auto", "On", "Off"], default:"Auto"},

		// TEMPORARY protocol probe. Remove before release. Answers what a DreamView "unit"
		// actually addresses on a device -- a single LED, a whole strand, or a zone spanning
		// several. Bypasses channels and components entirely so a dark result cannot be blamed
		// on component configuration.
		{property:"probeEnabled", group:"settings", label:"Protocol Probe", description: "TEMPORARY. Lights one strand white and everything else black, to check which strand is which.", type:"boolean", default:"false"},
		{property:"probeStrand", group:"settings", label:"Probe: Strand", description: "TEMPORARY. Which strand lights up. 1 to 20.", type:"number", min:"1", max:"20", default:"1", step:"1"},
		{property:"probeLedsPerStrand", group:"settings", label:"Probe: LEDs Per Strand", description: "TEMPORARY. How many colours we send per strand. 1 lights whole strands. Above 1 tests whether the device will split a strand.", type:"number", min:"1", max:"20", default:"1", step:"1"},
		{property:"probeLitLedsPerStrand", group:"settings", label:"Probe: Lit LEDs Per Strand", description: "TEMPORARY. How much of the chosen strand lights. Only does anything when LEDs Per Strand is above 1.", type:"number", min:"1", max:"20", default:"1", step:"1"},
		{property:"probePattern", group:"settings", label:"Probe: Pattern", description: "TEMPORARY. One Strand checks which strand is which. Two Stops puts red on strand 1 and blue on strand 3. Red, One Blue fills every strand red except the chosen one, which is the real test of whether the device blends between two colours. Rainbow gives all 20 strands a different hue.", type:"combobox", values:["One Strand", "Two Stops", "Red, One Blue", "Rainbow"], default:"One Strand"},
		{property:"probeModeByte", group:"settings", label:"Probe: Byte 4", description: "TEMPORARY. The byte before the colour count, which we have always sent as 1. Zero and non-zero render differently but we do not know what the field means. Try 0 and 1 against each pattern.", type:"number", min:"0", max:"8", default:"1", step:"1"},
	];
}

/** @type {GoveeProtocol} */
let govee;

const UnknownSkuLedCount = 120;

/** Strands on the H70BC curtain. Only used by the temporary probe. */
const StrandCount = 20;

/** Fully saturated colour for a hue in degrees. Only used by the temporary probe's rainbow. */
function HueToRgb(hue){
	const h = ((hue % 360) + 360) % 360;
	const x = 1 - Math.abs(((h / 60) % 2) - 1);

	let rgb = [1, x, 0];

	if(h >= 60 && h < 120){ rgb = [x, 1, 0]; }
	else if(h >= 120 && h < 180){ rgb = [0, 1, x]; }
	else if(h >= 180 && h < 240){ rgb = [0, x, 1]; }
	else if(h >= 240 && h < 300){ rgb = [x, 0, 1]; }
	else if(h >= 300){ rgb = [1, 0, x]; }

	return rgb.map((v) => Math.round(v * 255));
}

/** Channels this device renders through, in the order their colors go on the wire.
 * @type {{name: string, ledCount: number}[]} */
let channels = [];

/** Protocol used while protocolSelect is left on "Auto". Resolved per device from the
 * library, so a device only ever gets a protocol it's known to support. */
let autoProtocol = "Static";

/** Reset per Initialize so the first outbound frame is logged once. Initialize completing
 * does not mean Render is running, and the two failure modes look identical on the device. */
let loggedFirstFrame = false;

/** Frames since Initialize. Logged periodically so a render loop that never starts, or one
 * that starts and later stops, is visible instead of silent. */
let renderCount = 0;

/** Whether the socket has been seen connected since Initialize, so the setup commands can be
 * asserted once it actually is. */
let sawConnectedSocket = false;

/** So the "not initialized yet" warning is logged once rather than every frame. */
let loggedMissingProtocol = false;

/** Stream mode auto-disables in the device after roughly a minute, so it has to be re-asserted.
 * Each assert costs a brief blank on the device, so this is as slow as it can safely be rather
 * than as fast as possible. Timestamp, not a frame count -- a frame count means a different
 * interval on every device. */
const StreamingAssertInterval = 40000;
let lastStreamingAssert = 0;

export function Initialize(){
	loggedFirstFrame = false;
	renderCount = 0;
	sawConnectedSocket = false;
	lastStreamingAssert = 0;
	device.addFeature("base64");

	device.setName(controller.sku);
	device.setImageFromUrl(controller.deviceImage);

	if(UDPServer !== undefined) {
		UDPServer.stop();
		UDPServer = undefined;
	}
	//Make sure we don't have a server floating around still.

	UDPServer = new UdpSocketServer({
		ip : controller.ip,
		broadcastPort : 4003,
	});

	UDPServer.start();
	//Establish a new udp server. This is now required for using udp.send.

	fetchDeviceInfoFromTableAndConfigure();

	govee = new GoveeProtocol(controller.ip, controller.supportDreamView, controller.supportRazer);

	govee.setDeviceState(true);
	govee.SetStreamingMode(true);
}

export function Render(){
	// Initialize assigns govee only after fetchDeviceInfoFromTableAndConfigure has run, so if that
	// throws -- or Render is reached before Initialize at all -- govee is undefined and every call
	// below fails with "Cannot read property of undefined". Bail instead of throwing once per frame.
	if(govee === undefined){
		if(!loggedMissingProtocol){
			loggedMissingProtocol = true;
			device.log("Render called before the device finished initializing. Nothing to send yet.");
		}

		return;
	}

	// Uncomment to trace the render loop. Distinguishes a loop that never starts from one
	// that starts and later stops -- neither is otherwise visible, since a device holds its
	// last color rather than going dark.
	// if(renderCount % 300 === 0){
	// 	device.log(`Render tick ${renderCount}.`);
	// }

	// Initialize starts the socket and then sends the setup commands straight away, before
	// connect() has reported back, so they can go out on a socket that is not ready yet.
	// Watch for the connection landing instead and assert them then. A flag check per frame,
	// no blocking, and it works no matter how long the socket takes.
	if(!sawConnectedSocket && UDPServer !== undefined && UDPServer.connected){
		sawConnectedSocket = true;
		govee.setDeviceState(true);
		govee.SetStreamingMode(true);
	}

	// Stream mode is handed to us by one unacknowledged datagram, so a lost packet leaves the device
	// ignoring every frame while looking fine from here. Assert it on the opening frames to cover
	// that.
	//
	// It also has to be kept alive. The protocol reference mentions a one minute auto-disable, and
	// removing the periodic re-assert stranded both bench devices frozen on their last frame, which
	// is what losing stream mode looks like -- the device holds what it has and ignores us.
	//
	// Timed rather than counted. The old version fired every 150 frames, which is five seconds on a
	// device rendering at 30fps and seventy five on one crawling at 2 -- simultaneously flashing
	// constantly on fast devices and missing the timeout entirely on slow ones. Wall clock is the
	// only thing that relates to a firmware timeout.
	//
	// Every assert costs a brief blank, so this is a floor and not something to lower casually.
	const now = Date.now();

	if(now - lastStreamingAssert > StreamingAssertInterval){
		lastStreamingAssert = now;
		govee.SetStreamingMode(true);
	}

	renderCount++;

	govee.SendRGB();
	device.pause(10);
}

export function Shutdown(SystemSuspending){
	// Shutdown runs on paths where Initialize never completed -- a device that failed to come up,
	// or a reload racing teardown -- so govee can be undefined here. Throwing in Shutdown is
	// particularly bad: the host discards the result on the app-exit path, so it surfaces as the
	// shutdown color silently not applying rather than as an error.
	if(govee === undefined){
		return;
	}

	// Hand control back to the device first. Anything streamed at it before this point is
	// discarded along with the stream, which is why the shutdown color never stuck.
	govee.SetStreamingMode(false);

	if(TurnOffOnShutdown){
		govee.setDeviceState(false);

		return;
	}

	// colorwc sets the device's own state, so it survives us going away. Color properties
	// arrive as objects rather than hex strings, so the conversion goes through
	// createColorArray like everywhere else. SendStaticColor skips SetStaticColor's
	// render-loop pause, which has no business running while the device is being torn down.
	const color = SystemSuspending ? "#000000" : shutdownColor;
	govee.SendStaticColor(device.createColorArray(color, 1, "Inline"));
}

function fetchDeviceInfoFromTableAndConfigure() {
	if(!GoveeDeviceLibrary.hasOwnProperty(controller.sku)){
		device.log(`SKU (${controller.sku}) not found on the library, using ${UnknownSkuLedCount} LEDs!`);
		device.setName(`Govee: ${controller.sku}`);
		// An unrecognised device gets the one protocol every Govee light accepts.
		autoProtocol = "Static";
		ConfigureChannels([{ name: `Channel 1`, ledCount: UnknownSkuLedCount }]);

		return;
	}

	const GoveeDeviceInfo = GoveeDeviceLibrary[controller.sku];
	blendByDefault = GoveeDeviceInfo.blendSegments ?? true;
	device.setName(`Govee ${GoveeDeviceInfo.sku} - ${GoveeDeviceInfo.name}`);
	autoProtocol = GetAutoProtocol(GoveeDeviceInfo);
	device.log(`Auto protocol for ${GoveeDeviceInfo.sku} resolved to ${autoProtocol}.`);
	ConfigureChannels(GetChannelLayout(GoveeDeviceInfo));
}

function GetAutoProtocol(GoveeDeviceInfo){
	if(GoveeDeviceInfo.supportDreamView){
		return "Dreamview";
	}

	if(GoveeDeviceInfo.supportRazer){
		return "RazerV1";
	}

	// Everything else only ever responded to plain colorwc commands.
	return "Static";
}

/** Whether to let the firmware fade between the colors we send. Auto defers to the library, since
 * whether blending helps depends on the device being one continuous run of LEDs rather than
 * several separate pieces. */
function ShouldBlend(){
	if(blendSegments === "On"){
		return true;
	}

	if(blendSegments === "Off"){
		return false;
	}

	return blendByDefault;
}

function GetChannelLayout(GoveeDeviceInfo){
	// Devices built from multiple segments (paired light bars and the like) get a channel
	// each, so every segment can be given its own component.
	if(GoveeDeviceInfo.usesSubDevices){
		return GoveeDeviceInfo.subdevices.map((subdevice, index) => ({
			name: `Channel ${index + 1}`,
			ledCount: subdevice.ledCount
		}));
	}

	return [{ name: `Channel 1`, ledCount: GoveeDeviceInfo.ledCount }];
}

function ConfigureChannels(layout){
	channels = layout;

	let totalLedCount = 0;

	for(const channel of channels){
		device.addChannel(channel.name, channel.ledCount);
		device.channel(channel.name).SetLedLimit(channel.ledCount);
		totalLedCount += channel.ledCount;
	}

	device.SetLedLimit(totalLedCount);
}

// -------------------------------------------<( Discovery Service )>--------------------------------------------------
let UDPServer;

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/govee/logo.png";
	this.firstRun = true;

	this.Initialize = function(){
		service.log("Searching for Govee network devices...");
	};

	this.UdpBroadcastPort = 4001;
	this.UdpListenPort = 4002;
	this.UdpBroadcastAddress = "239.255.255.250";

	this.lastPollTime = 0;
	this.PollInterval = 60000;

	this.cache = new IPCache();
	this.activeSockets = new Map();
	this.activeSocketTimer = Date.now();

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Devices...");

		for(const [key, value] of this.cache.Entries()){
			service.log(`Found Cached Device: [${key}: ${JSON.stringify(value)}]`);
			
			this.CreateControllerDevice(value);
			this.checkCachedDevice(value.ip);

			// A device in the cache is one the user has already accepted, so control it unless they
			// have explicitly said not to. The stored flag is named "paired", but the only thing it
			// ever means is "ignored": unlink writes false, nothing else does. Requiring true left
			// anyone whose flag was lost -- or never written -- with a device that appears in the
			// list and does nothing, recoverable only by pressing Link, which is not a thing we can
			// ask of people.
			if(value.paired !== false){
				this.link(value)
			}
		}
	};

	this.checkCachedDevice = function(ipAddress) {
		service.log(`Checking IP: ${ipAddress}`);

		if(UDPServer !== undefined) {
			UDPServer.stop();
			UDPServer = undefined;
		}

		const socketServer = new UdpSocketServer({
			ip : ipAddress,
			isDiscoveryServer : true
		});

		this.activeSockets.set(ipAddress, socketServer);
		this.activeSocketTimer = Date.now();
		socketServer.start();
	};

	this.clearSockets = function() {
		if(Date.now() - this.activeSocketTimer > 10000 && this.activeSockets.size > 0) {
			service.log("Clearing inactive devices Sockets. All cached devices should have responded by now if they were online.");

			for(const [key, value] of this.activeSockets.entries()){
				service.log(`Clearing Socket for IP: [${key}]`);
				value.stop();
				this.activeSockets.delete(key);
				//Clear would be more efficient here, however it doesn't kill the socket instantly.
				//We instead would be at the mercy of the GC.
			}
		}
	};

	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval){
			return;
		}

		discovery.lastPollTime = Date.now();
		service.log("Broadcasting device scan...");
		service.broadcast(JSON.stringify({
			msg: {
				cmd: "scan",
				data: {
					account_topic: "reserve",
				},
			}
		}));
	};

	this.Discovered = function(value) {
		const response	= JSON.parse(value.response);

		// Check if the response packet has the "scan" response from Govee
		if(response.msg.cmd != "scan"){
			return;
		}

		// Check if the response packet has the ip field in the response from Govee
		const isValid = response.msg.data.hasOwnProperty("ip");

		if(!isValid){
			service.log(`Potential Govee device ${response.msg.data.sku} found at ${value.ip} discarded since it's missing an IP field. If this is a Matter device, is not supported yet.`);
			service.log(response.msg.data)
			return;
		}

		// Only log the find once, but always fall through to CreateControllerDevice so a
		// cached device whose controller went missing is rebuilt on the next scan.
		if(!this.cache.Has(value.id)){
			service.log(`Govee device ${response.msg.data.sku} discovered at ${value.ip}!`);
		}

		this.CreateControllerDevice(value);
	};

	this.forceDiscovery = function(value) {
		this.Discovered(value);
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.Update = function(){

		if(this.firstRun){
			this.LoadCachedDevices();
			this.firstRun = false;
		}

		for(const cont of service.controllers){
			cont.obj.update();
		}

		this.clearSockets();
		this.CheckForDevices();
	};

	this.getSocket = function(key) {
		return this.activeSockets.get(key);
	};

	this.Shutdown = function(){

	};

	this.remove = function(controllerObj = false){

		if (controllerObj) {
			service.log(`Stopping UDP Socket for ${controllerObj.ip}`);
			const udpSocket = this.getSocket(controllerObj.ip);
			if(udpSocket){
				udpSocket.stop();
				this.activeSockets.delete(controllerObj.ip);
			}

			service.log(`Removing from cache: ${controllerObj.id}`);
			this.cache.Remove(controllerObj.id)
			
			service.log(`Removing controller: ${controllerObj.id}`);
			service.suppressController(controllerObj);
			service.removeController(controllerObj);
		} else {
			this.cache.PurgeCache();
			const cachedDevices = this.cache.Entries()
			console.log(cachedDevices);
	
			for(const [key, value] of cachedDevices){
				service.log(`Removing Cached Device: [${key}: ${JSON.stringify(value)}]`);
				service.suppressController(value);
				service.removeController(value);
			}

			this.cache.DumpCache();
		}

	};

	this.CreateControllerDevice = function(value){
		// Cache entries are keyed by their own id, so going through the cache to find the
		// controller id is a round trip to the same value. Ask the service directly.
		const controller = service.getController(value.id);

		if(controller === undefined){
			service.log(`No controller found for ${value.id}, creating one!`);
			service.addController(new GoveeController(value));
		}else{
			controller.updateWithValue(value);
		}
	};

	this.link = function(controllerObj){
		service.log(`Linking controller: ${controllerObj.id} - Paired: ${controllerObj.paired} `);

		const controller = service.getController(controllerObj.id);

		if(controller === undefined){
			service.log(`Cannot link ${controllerObj.id}, no controller exists for it.`);

			return;
		}

		controller.paired = true;

		// Update controller
		controller.updateWithValue(controller);
		service.announceController(controller);

		// Update cache
		this.cacheControllerInfo(controller);

		service.log(`Linked controller: ${controller.id} - Paired: ${controller.paired} `);
	}

	this.unlink = function(controllerObj) {
		service.log(`Unlinking controller: ${JSON.stringify(controllerObj)}`);

		const controller = service.getController(controllerObj.id);

		if(controller === undefined){
			service.log(`Cannot unlink ${controllerObj.id}, no controller exists for it.`);

			return;
		}

		// Sockets are keyed by IP, not by controller id.
		service.log(`Stopping UDP Socket for ${controllerObj.ip}`);
		const udpSocket = this.getSocket(controllerObj.ip);
		if(udpSocket){
			udpSocket.stop();
			this.activeSockets.delete(controllerObj.ip);
		}

		controller.paired = false;

		controller.updateWithValue(controller);
		service.suppressController(controller);

		// Update cache
		this.cacheControllerInfo(controller);
	}

	this.cacheControllerInfo = function(value) {
		discovery.cache.Add(
			value.id, {
				id: value.id,
				paired: value.paired,
				ip: value.ip,
				name: value.sku,
				GoveeInfo: value.GoveeInfo,
				supportDreamView: value.GoveeInfo.supportDreamView,
				supportRazer: value.GoveeInfo.supportRazer,
				deviceImage: value.GoveeInfo.deviceImage,
				device: value.device,
				sku: value.sku,
				bleVersionHard: value.bleVersionHard,
				bleVersionSoft: value.bleVersionSoft,
				wifiVersionHard: value.wifiVersionHard,
				wifiVersionSoft: value.wifiVersionSoft,
				initialized: value.initialized
			}
		);
	}
}

class GoveeController{
	 constructor(value){
		this.id = value?.id ?? "Unknown ID";
		// Discovery responses carry no pairing state, and this constructor persists straight
		// to the cache below. Without the cache fallback a scan reply that arrives before the
		// cached devices load rebuilds the controller as unpaired and writes that over the
		// stored true, so the device stops linking itself on startup.
		this.paired = value?.paired ?? discovery.cache.Get(this.id)?.paired ?? false;

		let response;

		// Handle discovery or cached device
		if (value.response) {
			const packet = JSON.parse(value.response).msg;
			response = packet.data;
		} else {
			response = value
		}

		service.log(response);

		this.ip = response?.ip ?? "Unknown IP";
		this.name = response?.sku ?? "Unknown SKU";


		this.GoveeInfo = this.GetGoveeDevice(response.sku);
		this.supportDreamView = this.GoveeInfo?.supportDreamView;
		this.supportRazer = this.GoveeInfo?.supportRazer;
		this.deviceImage = this.GoveeInfo?.deviceImage;

		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";
		this.initialized = false;

		this.DumpControllerInfo();

		if(this.name !== "Unknown SKU") {
			this.cacheControllerInfo(this);
		}
	}

	GetGoveeDevice(sku){
		if(GoveeDeviceLibrary.hasOwnProperty(sku)){
		  return GoveeDeviceLibrary[sku];
		}

		return {
			name: "Unknown",
			supportDreamView: false,
			supportRazer: false,
			deviceImage: "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png"
		};
	}

	DumpControllerInfo(){
		service.log(`id: ${this.id}`);
		service.log(`ip: ${this.ip}`);
		service.log(`device: ${this.device}`);
		service.log(`sku: ${this.sku}`);
		service.log(`bleVersionHard: ${this.bleVersionHard}`);
		service.log(`bleVersionSoft: ${this.bleVersionSoft}`);
		service.log(`wifiVersionHard: ${this.wifiVersionHard}`);
		service.log(`wifiVersionSoft: ${this.wifiVersionSoft}`);
		service.log(`Supports Razer: ${this.supportRazer ? 'yes': 'no'}`);
		service.log(`Supports DreamView: ${this.supportDreamView ? 'yes': 'no'}`);
	}

	updateWithValue(value){
		this.id = value.id;
		// Discovery responses carry no pairing state, so only take it when it's actually
		// present. Assigning it blindly unpaired the device on every scan reply.
		this.paired = value.paired ?? this.paired;

		let response;

		// Handle discovery or cached device
		if (value.response) {
			response = JSON.parse(value.response).msg.data;
		} else {
			response = value
		}

		this.ip = response?.ip ?? "Unknown IP";
		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";

		service.updateController(this);
	}

	update(){
		if(!this.initialized){
			this.initialized = true;
			service.updateController(this);
			service.announceController(this);
		}
	}

	cacheControllerInfo(value){
		discovery.cache.Add(
			value.id, {
				id: value.id,
				paired: value.paired,
				ip: value.ip,
				name: value.sku,
				GoveeInfo: value.GoveeInfo,
				supportDreamView: value.GoveeInfo.supportDreamView,
				supportRazer: value.GoveeInfo.supportRazer,
				deviceImage: value.GoveeInfo.deviceImage,
				device: value.device,
				sku: value.sku,
				bleVersionHard: value.bleVersionHard,
				bleVersionSoft: value.bleVersionSoft,
				wifiVersionHard: value.wifiVersionHard,
				wifiVersionSoft: value.wifiVersionSoft,
				initialized: value.initialized
			}
		);
	}
}

class GoveeProtocol {

	constructor(ip, supportDreamView, supportRazer){
		this.ip = ip;
		this.port = 4003;
		this.lastPacket = 0;
		this.supportDreamView = supportDreamView;
		this.supportRazer = supportRazer;
	}

	setDeviceState(on){
		UDPServer.send(JSON.stringify({
			"msg": {
				"cmd": "turn",
				"data": {
					"value": on ? 1 : 0
				}
			}
		}));
	}

	SetBrightness(value) {
		UDPServer.send(JSON.stringify({
			"msg": {
				"cmd":"brightness",
				"data": {
					"value":value
				}
			}
		}));
	}

	/** Hands control of the device to the network, or gives it back. Nothing to do with the
	 * Razer protocol despite the JSON envelope -- "razer" is simply how the LAN API carries
	 * any encoded packet, colour frames included. The payloads decode to
	 * BB 00 01 B1 01 0A and BB 00 01 B1 00 0B: command 0xB1, enable and disable. Colour
	 * frames (0xB0) are ignored unless this has been enabled.
	 *
	 * NOT FREE TO SEND. Enabling costs a brief blank on the device as it re-enters stream mode.
	 * One is unnoticeable at startup; on a repeat it reads as a black flash, and sending it every
	 * 150 frames was the source of the flicker reports. Send it when control is actually being
	 * taken, never on a timer, and never as a cheap "just in case". */
	SetStreamingMode(enable){
		UDPServer.send(JSON.stringify({msg:{cmd:"razer", data:{pt:enable?"uwABsQEK":"uwABsQAL"}}}));
	}

	calculateXorChecksum(packet) {
		let checksum = 0;

		for (let i = 0; i < packet.length; i++) {
		  checksum ^= packet[i];
		}

		return checksum;
	}

	// Byte 4, before the colour count, changes how the device treats the colours. We sent 0x01 for
	// years without knowing what it meant. Measured on an H70BC curtain: at 0x00 a colour fills its
	// segment cleanly, at 0x01 it bleeds into the neighbouring segment. Anything above 1 behaves
	// like 1, which rules out a bit flag.
	//
	// 0x00 is the right default. SignalRGB hands us one colour per addressable segment and expects
	// them applied as given, and on a curtain the bleed crosses a physical gap between strands that
	// does not exist in the light. Whatever the field is really called, we want the version that
	// does not smear our pixels.
	//
	// Overridable so the probe can sweep it.
	createDreamViewPacket(colors, mode = 0x00) {
		// Define the Dreamview protocol header

		const packetToCheck = [mode & 0xff, colors.length / 3].concat(colors);

		const header = [0xBB, (packetToCheck.length >> 8 & 0xff), (packetToCheck.length & 0xff), 0xB0];
		const fullPacket = header.concat(packetToCheck);
		const checksum = this.calculateXorChecksum(fullPacket);
		fullPacket.push(checksum);

		return fullPacket;
	}

	createRazerPacketV1(colors) {
		// Define the Razer protocol header
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		fullPacket.push(0); // Checksum

		return fullPacket;
	}

	createRazerPacketV2(colors) {
		// Define the Razer protocol header
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length];
		const fullPacket = header.concat(colors);
		fullPacket.push(this.calculateXorChecksum(fullPacket)); // Checksum

		return fullPacket;
	}

	SendStaticColor(RGBData){
		UDPServer.send(JSON.stringify({
			msg: {
				cmd: "colorwc",
				data: {
					color: {r: RGBData[0], g: RGBData[1], b: RGBData[2]},
					colorTemInKelvin: 0
				}
			}
		}));
	}

	SetStaticColor(RGBData){
		this.SendStaticColor(RGBData);

		// colorwc changes device state rather than streaming a frame, so the render loop has
		// to throttle itself or it floods the device. Only wanted on the render path.
		device.pause(100);
	}

	SendEncodedPacket(packet){
		const command = base64.Encode(packet);

		if(!loggedFirstFrame){
			loggedFirstFrame = true;
			device.log(`Streaming started: ${packet.length} byte frame over ${channels.length} channel(s).`);
		}

		// Debug
		//device.log(`[${protocolSelect}] segments=${(packet.length - 7)/3 | 0} raw packet bytes=${packet.length}`);

		const now = Date.now();

		if (now - this.lastPacket > 1000) {
			UDPServer.send(JSON.stringify({
				msg: {
					cmd: "status",
					data: {}
				}
			}));
			this.lastPacket = now;
		}

		UDPServer.send(JSON.stringify({
			msg: {
				cmd: "razer",
				data: {
					pt: command,
				},
			},
		}));
	}

	GetChannelRGB(channelName, overrideColor){
		const componentChannel = device.channel(channelName);
		const ChannelLedCount = componentChannel.LedCount();

		if(overrideColor) {
			return device.createColorArray(overrideColor, ChannelLedCount, "Inline");
		}

		if(LightingMode === "Forced"){
			return device.createColorArray(forcedColor, ChannelLedCount, "Inline");
		}

		if(componentChannel.shouldPulseColors()){
			const pulseColor = device.getChannelPulseColor(channelName);
			const pulseCount = componentChannel.LedLimit();

			return device.createColorArray(pulseColor, pulseCount, "Inline");
		}

		return componentChannel.getColors("Inline");
	}

	// TEMPORARY. Remove with the probe properties.
	//
	// Three patterns, because a single white strand against black is the least informative thing
	// we can send -- it cannot tell "discrete" apart from several other behaviours, and black is
	// ambiguous between "off" and "interpolating towards off".
	//
	//   One Strand   the chosen strand white, rest black. Confirms which strand is which.
	//   Two Stops    strand 1 red, strand 3 blue, rest black. Strand 2 is the tell: blended
	//                purple means the device interpolates between colours, dark means it does
	//                not. Two known colours with a gap, so nothing hinges on reading black.
	//   Rainbow      all 20 strands a distinct hue. Proves the whole mapping in one look,
	//                including order and any off-by-one.
	//
	// Byte 4 of the frame is exposed as probeModeByte. Observed: 0 gives discrete strands, 1 puts
	// a ramp on the preceding strand, and anything above 1 behaves like 1. That last part means it
	// is not a bit flag -- 2 would clear bit 0 and behave like 0 if it were. So it is a zero
	// versus non-zero test in firmware and its actual meaning is still unknown. "Mode" is a label,
	// not a finding.
	//
	// Every colour is written every frame, so nothing lingers if the device holds state, and the
	// colours are built by hand rather than read from the canvas, so this tests the device and the
	// packet only with the component layout out of the picture.
	SendProbeFrame(){
		const perStrand = Math.max(1, Math.min(20, Number(probeLedsPerStrand) | 0));
		const strand = Math.max(1, Math.min(StrandCount, Number(probeStrand) | 0));
		const lit = Math.max(1, Math.min(perStrand, Number(probeLitLedsPerStrand) | 0));

		const colourCount = StrandCount * perStrand;
		const RGBData = new Array(colourCount * 3).fill(0);

		const paint = (index, rgb) => {
			const at = index * 3;

			if(at + 2 >= RGBData.length){
				return;
			}

			RGBData[at] = rgb[0];
			RGBData[at + 1] = rgb[1];
			RGBData[at + 2] = rgb[2];
		};

		if(probePattern === "Two Stops"){
			// Strand 1 red, strand 3 blue, strand 2 left at black.
			//
			// Note this cannot show a red-to-blue blend: strand 2's slot is not a gap, it is a
			// black stop, so a device that interpolates ramps black to blue across it rather than
			// red to blue. Kept because that is still a useful signal, but "Red, One Blue" is the
			// pattern that actually tests blending between two colours.
			paint(0, [255, 0, 0]);
			paint(2 * perStrand, [0, 0, 255]);
		}else if(probePattern === "Red, One Blue"){
			// Every strand red except the chosen one, which is blue. No black anywhere, so the
			// strands either side of the blue one have red and blue as neighbouring stops. A
			// device that blends must show purple there; one that does not shows hard edges.
			for(let s = 0; s < StrandCount; s++){
				paint(s * perStrand, [255, 0, 0]);
			}

			paint((strand - 1) * perStrand, [0, 0, 255]);
		}else if(probePattern === "Rainbow"){
			for(let s = 0; s < StrandCount; s++){
				paint(s * perStrand, HueToRgb((s * 360) / StrandCount));
			}
		}else{
			const firstOnStrand = (strand - 1) * perStrand;

			for(let i = 0; i < lit; i++){
				paint(firstOnStrand + i, [255, 255, 255]);
			}
		}

		const mode = Math.max(0, Math.min(255, Number(probeModeByte) | 0));
		const packet = this.createDreamViewPacket(RGBData, mode);

		if(renderCount % 120 === 0){
			const hex = packet.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(" ");
			device.log(`Probe [${probePattern}]: strand ${strand}, lighting ${lit} of ${perStrand} per strand, `
				+ `${colourCount} colours sent, byte4 ${mode}, frame ${packet.length} bytes.`);
			device.log(`Probe frame: ${hex.length > 320 ? `${hex.slice(0, 320)}...` : hex}`);
		}

		this.SendEncodedPacket(packet);
	}

	SendRGB(overrideColor) {
		let RGBData = [];
		let packet  = [];

		if(probeEnabled){
			this.SendProbeFrame();

			return;
		}

		// Segments go on the wire in channel order, matching how the device chains them.
		for(const channel of channels){
			RGBData = RGBData.concat(this.GetChannelRGB(channel.name, overrideColor));
		}

		switch (protocolSelect === "Auto" ? autoProtocol : protocolSelect) {
			// One Dreamview frame, with the length computed. The old split into V1/V2 was really
			// a broken implementation sitting next to a correct one, not two protocol versions.
			case "Dreamview":
				packet = this.createDreamViewPacket(RGBData, ShouldBlend() ? 0x01 : 0x00);
				this.SendEncodedPacket(packet);
				break;
			case "RazerV1":
				packet = this.createRazerPacketV1(RGBData);
				this.SendEncodedPacket(packet);
				break;
			case "RazerV2":
				packet = this.createRazerPacketV2(RGBData);
				this.SendEncodedPacket(packet);
				break;
			case "Static":
				this.SetStaticColor(RGBData.slice(0, 3));
				break;
		
			default:
				this.SetStaticColor(RGBData.slice(0, 3));
				break;
		}
	}
}

class UdpSocketServer{
	constructor (args) {
		this.count = 0;
		/** @type {udpSocket | null} */
		this.server = null;
		this.listenPort = args?.listenPort ?? 0;
		this.broadcastPort = args?.broadcastPort ?? 4001;
		this.ipToConnectTo = args?.ip ?? "239.255.255.250";
		this.isDiscoveryServer = args?.isDiscoveryServer ?? false;
		this.connected = false;

		this.log = (msg) => { this.isDiscoveryServer ? service.log(msg) : device.log(msg); };

		this.responseCallbackFunction = (msg) => { this.log("No Response Callback Set Callback cannot function"); msg; };
	}

	setCallbackFunction(responseCallbackFunction) {
		this.responseCallbackFunction = responseCallbackFunction;
	}

	write(packet, address, port) {
		if(!this.server) {
			this.server = udp.createSocket();
		}

		this.server.write(packet, address, port);
	}

	send(packet) {
		if(!this.server) {
			this.server = udp.createSocket();
			this.log("Defining new UDP Socket so we can send data.");
		}

		this.server.send(packet);
	}

	start(){
		this.server = udp.createSocket();

		if(this.server){
			// Given we're passing class methods to the server, we need to bind the context (this instance) to the function pointer
			this.server.on('error', this.onError.bind(this));
			this.server.on('message', this.onMessage.bind(this));
			this.server.on('listening', this.onListening.bind(this));
			this.server.on('connection', this.onConnection.bind(this));
			this.server.bind(this.listenPort);
			this.server.connect(this.ipToConnectTo, this.broadcastPort);
		}
	};

	stop(){
		this.connected = false;

		if(this.server) {
			this.server.disconnect();
			this.server.close();
		}
	}

	onConnection(){
		this.connected = true;
		this.log('Connected to remote socket!');
		this.log("Socket information:");
		this.log(this.server.remoteAddress(), {pretty: true});

		if(this.isDiscoveryServer) {
			this.log("Sending Check to socket and waiting for device to respond...");

			const bytesWritten = this.server.send(JSON.stringify({
				msg: {
					cmd: "scan",
					data: {
						account_topic: "reserve",
					},
				}
			}));

			if(bytesWritten === -1){
				this.log('Error sending data to remote socket');
			}
		}
	};

	onListenerResponse(msg) {
		this.log('Data received from client');
		this.log(msg, {pretty: true});
	}

	onListening(){
		const address = this.server.address();
		this.log(`Server is listening at port ${address.port}`);

		// Check if the socket is bound (no error means it's bound but we'll check anyway)
		this.log(`Socket Bound: ${this.server.state === this.server.BoundState}`);
	};
	onMessage(msg){
		this.log('Data received from client');
		this.log(msg, {pretty: true});

		if(this.isDiscoveryServer) {
			discovery.forceDiscovery(msg);
			this.server.close();
		}
	};
	onError(code, message){
		this.log(`Error: ${code} - ${message}`);
		this.server.close(); // We're done here
	};
}

class IPCache{
	constructor(){
		this.cacheMap = new Map();
		this.persistanceId = "ipCache";
		this.persistanceKey = "cache";

		this.PopulateCacheFromStorage();
	}
	Add(key, value){
		service.log(`Adding ${key} to IP Cache...`);

		this.cacheMap.set(key, value);
		this.Persist();
	}

	Remove(key){
		this.cacheMap.delete(key);
		this.Persist();
	}
	Has(key){
		return this.cacheMap.has(key);
	}
	Get(key){
		return this.cacheMap.get(key);
	}
	Entries(){
		return this.cacheMap.entries();
	}

	PurgeCache() {
		service.removeSetting(this.persistanceId, this.persistanceKey);
		service.log("Purging IP Cache from storage!");
	}

	PopulateCacheFromStorage(){
		service.log("Populating IP Cache from storage...");

		const storage = service.getSetting(this.persistanceId, this.persistanceKey);

		if(storage === undefined){
			service.log(`IP Cache is empty...`);

			return;
		}

		let mapValues;

		try{
			mapValues = JSON.parse(storage);
		}catch(e){
			service.log(e);
		}

		if(mapValues === undefined){
			service.log("Failed to load cache from storage! Cache is invalid!");

			return;
		}

		if(mapValues.length === 0){
			service.log(`IP Cache is empty...`);
		}

		this.cacheMap = new Map(mapValues);
	}

	Persist(){
		service.log("Saving IP Cache...");
		service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
	}

	DumpCache(){
		for(const [key, value] of this.cacheMap.entries()){
			service.log([key, value]);
		}
	}
}

// eslint-disable-next-line max-len
/** @typedef { {name: string, ledCount: number, size: number[], ledNames: string[], ledPositions: number[][] } } GoveeSubdevice */
/** blendSegments: whether the device should fade between the colors we send rather than applying
 * each to its own segment. Absent means blend, matching what shipped before the byte was
 * understood. Set false on anything built from separate physical pieces -- on a curtain the fade
 * crosses the gap between two hanging strands, a seam that exists in the data order and not in
 * the light. */
// eslint-disable-next-line max-len
/** @typedef { {name: string, deviceImage: string, sku: string, state: number, supportRazer: boolean, supportDreamView: boolean, ledCount: number, hasVariableLedCount?: boolean, usesSubDevices?: boolean, subdevices?: GoveeSubdevice[], blendSegments?: boolean } } GoveeDevice */
/** @type {Object.<string, GoveeDevice>} */
const GoveeDeviceLibrary = {
	H6061: {
		name: "Glide Hexa Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6061.png",
		sku: "H6061",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H6062: {
		name: "Glide Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6062.png",
		sku: "H6062",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 29, // This can support more? 5 * Segment Count - 1?
		hasVariableLedCount: true,
	},
	H6065: {
		name: "Glide Y Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6065.png",
		sku: "H6065",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6066: {
		name: "Glide Hexa Pro Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6066.png",
		sku: "H6066",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6067: {
		name: "Glide Tri Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6067.png",
		sku: "H6067",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6609: {
		name: "Gaming Light Strip G1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6609.png",
		sku: "H6609",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H610A: {
		name: "Glide Lively Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h610a.png",
		sku: "H610A",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 24
	},
	H610B: {
		name: "Glide Music Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h610b.png",
		sku: "H610B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6087: {
		name: "RGBIC Fixture Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6087.png",
		sku: "H6087",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6056: {
		name: "Flow Plus Light Bar",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6056.png",
		sku: "H6056",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "Flow Plus Light Bar",
				ledCount: 3,
				size: [1, 3],
				ledNames: ["Led 1", "Led 2", "Led 3"],
				ledPositions: [[0, 0], [0, 1], [0, 2]],
			},
			{
				name: "Flow Plus Light Bar",
				ledCount: 3,
				size: [1, 3],
				ledNames: ["Led 1", "Led 2", "Led 3"],
				ledPositions: [[0, 0], [0, 1], [0, 2]],
			},
		]
	},
	H6046: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6046.png",
		sku: "H6046",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H6047: {
		name: "RGBIC Gaming Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6047.png",
		sku: "H6047",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6048: {
		name: "RGBIC TV Light Bars Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6048.png",
		sku: "H6048",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars Pro",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars Pro",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H6051: {
		name: "Table Lamp Lite",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6052.png",
		sku: "H6051",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 15
	},
	H6059: {
		name: "RGB Night Light Mini",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6059.png",
		sku: "H6059",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6052: {
		name: "RGBICWW Table Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6052.png",
		sku: "H6052",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A0: {
		name: "3m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A1: {
		name: "2m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A2: {
		name: "5m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 70
	},
	H61A3: {
		name: "4m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619A: {
		name: "5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H619B: {
		name: "7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619B",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619C: {
		name: "10m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619D: {
		name: "2*7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619D",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619E: {
		name: "2*10m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619E",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H619Z: {
		name: "3m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619Z",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 12
	},
	H61B2: {
		name: "3m RGBIC Neon TV Backlight",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B2",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61B5: {
		name: "3m RGBIC Neon TV Backlight",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B5",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 15
	},
	H61C2: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 16
	},
	H61C3: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 42
	},
	H61C5: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C5",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H61E0: {
		name: "LED Strip Light M1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e0.png",
		sku: "H61E0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H61E1: {
		name: "LED Strip Light M1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e0.png",
		sku: "H61E1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6172: {
		name: "10m Outdoor RGBIC Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6172.png",
		sku: "H6172",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615A: {
		name: "5m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6110: {
		name: "2*5m MultiColor Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6110.png",
		sku: "H6110",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618A: {
		name: "5m RGBIC Basic Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC Basic Strip Light",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H618C: {
		name: "10m RGBIC Basic Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 12
	},
	H618E: {
		name: "2*10m RGBIC Bassic Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618E",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6117: {
		name: "2*5m RGBIC Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6117.png",
		sku: "H6117",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A5: {
		name: "10m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H615B: {
		name: "10m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615C: {
		name: "15m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615C",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615D: {
		name: "15m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615D",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618F: {
		name: "2*15m RGBIC LED Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618F",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6072: {
		name: "RGBICWW Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6072.png",
		sku: "H6072",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 8
	},
	H6073: {
		name: "Smart RGB Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6073.png",
		sku: "H6073",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6076: {
		name: "RGBICW Floor Lamp Basic",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6076.png",
		sku: "H6076",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 68
	},
	H6079: {
		name: "RGBICWW Floor Lamp Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6079.png",
		sku: "H6079",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10,
	},
	H7060: {
		name: "4 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7060",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7061: {
		name: "2 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7061",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7062: {
		name: "6 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7062",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H70B1: {
		name: "Curtain Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h70b1.png",
		sku: "H70B1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10
	},
	H70BC: {
		name: "Netflix Curtain Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h70b1.png",
		sku: "H70BC",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		// 400 physical LEDs in 20 hanging strands, but DreamView only addresses the strands: one
		// colour lights one whole strand, and colour index maps to strand 1:1. Verified on
		// hardware. Sending any other count makes the device spread the colours across the strands
		// in a way that does not match what was sent, and above 20 it blanks entirely. LedFx report
		// the same ceiling independently: "H70B1 Curtain Lights: ceases to work about 20".
		ledCount: 20,
		// Separate hanging strands, so blending fades across a gap that is not there in the light.
		blendSegments: false
	},
	H61D5: {
		name: "RGBIC Neon Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61d5.png",
		sku: "H61D5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 68,
		hasVariableLedCount: true
	},
	H6167: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
		sku: "H6167",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 10
	},
	H6168: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
		sku: "H6168",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H7075: {
		name: "Govee Outdoor Wall Light, 1500LM",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7075.png",
		sku: "H7075",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10
	},
	H606A: {
		name: "Hex Glide Ultra",
		deviceImage : "https://assets.signalrgb.com/devices/brands/govee/wifi/h606a.png",
		sku: "H606A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10, // Linked panels that goes up to 21 per controller
		hasVariableLedCount: true
	},
	H8022 : {
		name: "RGBIC Table Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h8022.png",
		sku: "H8022",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H8072: {
		name: "RGBIC Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h8072.png",
		sku: "H8072",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H7053: {
		name: "Outdoor Ground Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7053.png",
		sku: "H7053",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 30
	},
	H61B3: {
		name: "3m RGBIC LED Strip Light with Cover",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H7039: {
		name: "Smart Outdoor String Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7039.png",
		sku: "H7039",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 45
	},
	H60A1: {
		name: "Smart Ceiling Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h60a1.png",
		sku: "H60A1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 13
	},
	H702A: {
		name: "S14 Bulb Outdoor String Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h702a.png",
		sku: "H702A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61E6: {
		name: "COB LED Strip Light Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e6.png",
		sku: "H61E6",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 60
	},
	H612C: {
		name: " RGBIC LED Strip Lights With Protective Coating",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h612c.png",
		sku: "H612C",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 20
	},
};