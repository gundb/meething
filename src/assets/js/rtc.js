/**
 * @author Lorenzo Mangani, QXIP BV <lorenzo.mangani@gmail.com>
 * @date 27th April, 2020
 * @author Amir Sanni <amirsanni@gmail.com>
 * @date 6th January, 2020
 */
import h from "./helpers.js";
import EventEmitter from "./ee.js";
import DamEventEmitter from "./emitter.js";
import Presence from "./presence.js";
import MetaData from "./metadata.js";

var TIMEGAP = 6000;
var allUsers = [];
var enableHacks = false;
var meethrix = window.meethrix = false;

var root;
var room;
var username;
var title = "ChatRoom";
var localVideo;
var audio;
var isRecording = false;

window.addEventListener('DOMContentLoaded', function () {
  room = h.getQString(location.href, "room") ? h.getQString(location.href, "room") : "";
  username = sessionStorage && sessionStorage.getItem("username") ? sessionStorage.getItem("username") : "";
  title = room.replace(/_(.*)/, '');
  localVideo = document.getElementById("local");
  if (title && document.getElementById('chat-title')) document.getElementById('chat-title').innerHTML = title;
  initSocket();
  initRTC();
});

var socket;
var room;
var pc = []; // hold local peerconnection statuses
const pcmap = new Map(); // A map of all peer ids to their peerconnections.
var myStream;
var screenStream;
var mutedStream,
  audioMuted = false,
  videoMuted = false;
var socketId;
var damSocket;
var presence;
var metaData;

function initSocket() {
  var roomPeer = "https://gundb-multiserver.glitch.me/lobby";
  if (room) {
    roomPeer = "https://gundb-multiserver.glitch.me/" + room;
  }

  var peers = [roomPeer];
  var opt = { peers: peers, localStorage: false, radisk: false };
  root = Gun(opt);

  socket = root
    .get("rtcmeeting")
    .get(room)
    .get("socket");
}

function sendMsg(msg, local) {
  let data = {
    room: room,
    msg: msg,
    sender: username || socketId
  };

  //emit chat message
  if (!local) {
    if (data.sender && data.to && data.sender == data.to) return;
    if (!data.ts) data.ts = Date.now();
    metaData.sentChatData(data);
  }
  //add localchat
  h.addChat(data, "local");
}
var _ev = h.isiOS() ? 'pagehide' : 'beforeunload';
window.addEventListener(_ev,function () {
  presence.leave();
  pcmap.forEach((pc, id) => {
    if (pcmap.has(id)) {
      pcmap.get(id).close();
      pcmap.delete(id);
    }
  });
});

function initPresence() {
  presence = new Presence(root, room);
  damSocket.setPresence(presence);
  presence.enter();
}

function metaDataReceived(data) {
  if (data.event == "chat") {
    if (data.ts && Date.now() - data.ts > 5000) return;
    if (data.socketId == socketId || data.sender == socketId) return;
    if (data.sender == username) return;
    console.log("got chat", data);
    h.addChat(data, "remote");
  } else if (data.event == "notification") {
    if (data.ts && Date.now() - data.ts > 5000 || data.ts == undefined || data.username == username) return;
    if (data.subEvent == "recording") {
      if (data.isRecording) {
        var notification = data.username + " started recording this meething";
        h.showNotification(notification);
      } else {
        var notification = data.username + " stopped recording this meething"
        h.showNotification(notification);
      }
    } else if (data.subEvent == "grid") {
      if (data.isOngrid) {
        var notification = data.username + " is going off the grid";
        h.showNotification(notification);
      } else {
        var notification = data.username + " is back on the grid"
        h.showNotification(notification);
      }
    }
  } else if (data.username) {
    	if(data.username && data.socketId) h.swapUserDetails(data.socketId+"-title", data);
        if (data.talking) {
		console.log('Speaker Focus on ' + data.username);
		h.swapDiv(data.socketId+"-widget");
	}
  } else {
    console.log("META::" + JSON.stringify(data));
    //TODO @Jabis do stuff here with the data
    //data.socketId and data.pid should give you what you want
    //Probably want to filter but didnt know if you wanted it filter on socketId or PID

  }
}

function initRTC() {
  if (!room) {
    document.querySelector("#room-create").attributes.removeNamedItem("hidden");
  } else if (!username) {
    document
      .querySelector("#username-set")
      .attributes.removeNamedItem("hidden");
  } else {
    damSocket = new DamEventEmitter(root, room);
    initPresence();
    let commElem = document.getElementsByClassName("room-comm");

    for (let i = 0; i < commElem.length; i++) {
      commElem[i].attributes.removeNamedItem("hidden");
    }

    if (localVideo)
      mutedStream = h.setMutedStream(localVideo);

    document.getElementById("demo").attributes.removeNamedItem("hidden");

    socketId = h.uuidv4();
    metaData = new MetaData(root, room, socketId, metaDataReceived);
    metaData.sentControlData({ username: username, sender: username, status: "online", audioMuted: audioMuted, videoMuted: videoMuted });

    console.log("Starting! you are", socketId);

    // Initialize Session
    damSocket.out("subscribe", {
      room: room,
      socketId: socketId,
      name: username || socketId
    });

    //Do we do this here this is now triggered from DAM?
    damSocket.on('Subscribe', function (data) {
      console.log("Got channel subscribe", data);
      if (data.ts && Date.now() - data.ts > TIMEGAP * 2) {
        console.log("discarding old sub", data);
        return;
      }
      if (
        pc[data.socketId] !== undefined &&
        pc[data.socketId].connectionState == "connected"
      ) {
        console.log(
          "Existing peer subscribe, discarding...",
          pc[data.socketId]
        );
        return;
      }
      // Ignore self-generated subscribes
      if (data.socketId == socketId || data.sender == socketId) return;
      console.log("got subscribe!", data);

      if (data.to && data.to != socketId) return; // experimental on-to-one reinvite (handle only messages target to us)
      /* discard new user for connected parties? */
      if (
        pc[data.socketId] &&
        pc[data.socketId].iceConnectionState == "connected"
      ) {
        console.log("already connected to peer", data.socketId);
        //return;
      }
      // New Peer, setup peerConnection
      damSocket.out("newUserStart", {
        to: data.socketId,
        sender: socketId,
        name: data.name || data.socketId
      });
      pc.push(data.socketId);
      init(true, data.socketId);
    });

    damSocket.on('NewUserStart', function (data) {
      if (data.ts && Date.now() - data.ts > TIMEGAP) return;
      if (data.socketId == socketId || data.sender == socketId) return;
      if (
        pc[data.sender] &&
        pc[data.sender].connectionState == "connected" &&
        pc[data.sender].iceConnectionState == "connected"
      ) {
        console.log("already connected to peer?", data.socketId);
        return; // We don't need another round of Init for existing peers
      }
      pc.push(data.sender);
      init(false, data.sender);
    });

    damSocket.on('IceCandidates', function (data) {
      try {
        if (
          (data.ts && Date.now() - data.ts > TIMEGAP) ||
          !data.sender ||
          !data.to
        )
          return;
        console.log(
          data.sender.trim() + " is trying to connect with " + data.to.trim()
        );
        data.candidate = new RTCIceCandidate(data.candidate);
        if (!data.candidate) return;
      } catch (e) {
        console.log(e, data);
        return;
      }
      if (data.socketId == socketId || data.to != socketId) return;
      console.log("ice candidate", data);
      //data.candidate ? pc[data.sender].addIceCandidate(new RTCIceCandidate(data.candidate)) : "";
      data.candidate ? pc[data.sender].addIceCandidate(data.candidate) : "";
    });

    damSocket.on('SDP', function (data) {
      try {
        if (data.ts && Date.now() - data.ts > TIMEGAP) return;
        if (
          !data ||
          data.socketId == socketId ||
          data.sender == socketId ||
          !data.description
        )
          return;
        if (data.to !== socketId) {
          console.log("not for us? dropping sdp");
          return;
        }
      } catch (e) {
        console.log(e, data);
        return;
      }

      if (data.description.type === "offer") {
        data.description
          ? pc[data.sender].setRemoteDescription(
            new RTCSessionDescription(data.description)
          )
          : "";

        h.getUserMedia()
          .then(async stream => {
            if (localVideo) h.setVideoSrc(localVideo, stream);

            //save my stream
            myStream = stream;
            h.addAudio(myStream);

            stream.getTracks().forEach(track => {
              pc[data.sender].addTrack(track, stream);
            });

            let answer = await pc[data.sender].createAnswer();
	    // SDP Interop
	    // if (navigator.mozGetUserMedia) answer = Interop.toUnifiedPlan(answer);
	    // SDP Bitrate Hack
	    // if (answer.sdp) answer.sdp = h.setMediaBitrate(answer.sdp, 'video', 500);

            await pc[data.sender].setLocalDescription(answer);

            damSocket.out("sdp", {
              description: pc[data.sender].localDescription,
              to: data.sender,
              sender: socketId
            });
          })
          .catch(async e => {
            console.error(`answer stream error: ${e}`);
            if (!enableHacks) return;
            // start crazy mode lets answer anyhow
            console.log(
              "no media devices! answering receive only"
            );
            var answerConstraints = {
              OfferToReceiveAudio: true,
              OfferToReceiveVideo: true
            };
            let answer = await pc[data.sender].createAnswer(answerConstraints);
	    // SDP Interop
	    // if (navigator.mozGetUserMedia) answer = Interop.toUnifiedPlan(answer);
            await pc[data.sender].setLocalDescription(answer);

            damSocket.out("sdp", {
              description: pc[data.sender].localDescription,
              to: data.sender,
              sender: socketId
            });
            // end crazy mode
          });
      } else if (data.description.type === "answer") {
        pc[data.sender].setRemoteDescription(
          new RTCSessionDescription(data.description)
        );
      }
    });

    document.getElementById("chat-input").addEventListener("keypress", e => {
      if (e.which === 13 && e.target.value.trim()) {
        e.preventDefault();

        sendMsg(e.target.value);

        setTimeout(() => {
          e.target.value = "";
        }, 50);
      }
    });

    document.getElementById("toggle-video").addEventListener("click", e => {
      e.preventDefault();
      var muted = mutedStream ? mutedStream : h.getMutedStream();
      var mine = myStream ? myStream : muted;
      if (!mine) {
        return;
      }
      if (!videoMuted) {
        h.replaceVideoTrackForPeers(pcmap, muted.getVideoTracks()[0]).then(r => {
          videoMuted = true;
          h.setVideoSrc(localVideo,muted);
          e.srcElement.classList.remove("fa-video");
          e.srcElement.classList.add("fa-video-slash");
	  h.showNotification("Video Disabled");
        });
      } else {
        h.replaceVideoTrackForPeers(pcmap, mine.getVideoTracks()[0]).then(r => {
          h.setVideoSrc(localVideo,mine);
          videoMuted = false;
          e.srcElement.classList.add("fa-video");
          e.srcElement.classList.remove("fa-video-slash");
	  h.showNotification("Video Enabled");
        });
      }

    });

    document.getElementById("record-toggle").addEventListener("click", e => {
      e.preventDefault();

      if (!isRecording) {
        h.recordAudio();
        isRecording = true
        e.srcElement.classList.add("text-danger");
        e.srcElement.classList.remove("text-white");
	h.showNotification("Recording Started");

      } else {
        h.stopRecordAudio()
        isRecording = false
        e.srcElement.classList.add("text-white");
        e.srcElement.classList.remove("text-danger");
	h.showNotification("Recording Stopped");
      }
      metaData.sentNotificationData({ username: username, subEvent: "recording", isRecording: isRecording })
    });

    document.getElementById("toggle-mute").addEventListener("click", e => {
      e.preventDefault();
      var muted = mutedStream ? mutedStream : h.getMutedStream();
      var mine = myStream ? myStream : muted;
      if (!mine) {
        return;
      }
      //console.log("muted",audioMuted);
      if (!audioMuted) {
        h.replaceAudioTrackForPeers(pcmap, muted.getAudioTracks()[0]).then(r => {
          audioMuted = true;
          //localVideo.srcObject = muted; // TODO: Show voice muted icon on top of the video or something
          e.srcElement.classList.remove("fa-volume-up");
          e.srcElement.classList.add("fa-volume-mute");
          metaData.sentControlData({ muted: audioMuted });
 	  h.showNotification("Audio Muted");
        });
      } else {
        h.replaceAudioTrackForPeers(pcmap, mine.getAudioTracks()[0]).then(r => {
          audioMuted = false;
          //localVideo.srcObject = mine; 
          e.srcElement.classList.add("fa-volume-up");
          e.srcElement.classList.remove("fa-volume-mute");
          metaData.sentControlData({ muted: audioMuted });
 	  h.showNotification("Audio Unmuted");
        });
      }

    });

    document.getElementById("toggle-invite").addEventListener("click", e => {
      e.preventDefault();
      //if (!myStream) return;
      console.log("Re-Send presence to all users...");
      var r = confirm("Re-Invite ALL room participants?");
      if (r == true) {
        damSocket.out("subscribe", {
          room: room,
          socketId: socketId,
          name: username || socketId
        });
      }
    });

    document
      .getElementById("toggle-screen")
      .addEventListener("click", async e => {
        e.preventDefault();
        if (screenStream) {
          screenStream.getTracks().forEach(t => {
            t.stop();
            t.onended();
          });
        } else {
          var stream = await h.getDisplayMedia({ audio: true, video: true });
          var atrack = stream.getAudioTracks()[0];
          var vtrack = stream.getVideoTracks()[0];
          if (false) h.replaceAudioTrackForPeers(pcmap, atrack); // TODO: decide somewhere whether to stream audio from DisplayMedia or not
          h.replaceVideoTrackForPeers(pcmap, vtrack);
          h.setVideoSrc(localVideo,stream);
          vtrack.onended = function (event) {
            console.log("Screensharing ended via the browser UI");
            screenStream = null;
            if (myStream) {
              h.setVideoSrc(localVideo, myStream);
              h.replaceStreamForPeers(pcmap, myStream);
            }
            e.srcElement.classList.remove("sharing");
            e.srcElement.classList.add("text-white");
            e.srcElement.classList.remove("text-black");
          };
          screenStream = stream;
          e.srcElement.classList.add("sharing");
          e.srcElement.classList.remove("text-white");
          e.srcElement.classList.add("text-black");
        }
      });

    document.getElementById("private-toggle").addEventListener("click", e => {
      e.preventDefault();
      // Detect if we are already in private mode
      let keys = Object.keys(presence.root._.opt.peers);
      if (keys.length == 0) {
        //if in private mode, go public
        presence.onGrid(presence.room);
        e.srcElement.classList.remove("fa-lock");
        e.srcElement.classList.add("fa-unlock");
        metaData.sentNotificationData({ username: username, subEvent: "grid", isOngrid: false })
      } else {
        //if public, go private
        metaData.sentNotificationData({ username: username, subEvent: "grid", isOngrid: true })
        presence.offGrid();
        e.srcElement.classList.remove("fa-unlock");
        e.srcElement.classList.add("fa-lock");
      }
    });
  }
}

function init(createOffer, partnerName) {
  // OLD: track peerconnections in array
  if (pcmap.has(partnerName)) return pcmap.get(partnerName);
   var pcPartnerName = new RTCPeerConnection(h.getIceServer());
   pc[partnerName] = pcPartnerName;
  // DAM: replace with local map keeping tack of users/peerconnections
  pcmap.set(partnerName, pcPartnerName); // MAP Tracking
  h.addVideo(partnerName, false);

  // Q&A: Should we use the existing myStream when available? Potential cause of issue and no-mute
  if (screenStream) {
    var tracks = {};
    tracks['audio'] = screenStream.getAudioTracks();
    tracks['video'] = screenStream.getVideoTracks();
    if (myStream) {
      tracks['audio'] = myStream.getAudioTracks(); //We want sounds from myStream if there is such
      if (!tracks.video.length) tracks['video'] = myStream.getVideoTracks(); //also if our screenStream is malformed, let's default to myStream in that case
    }
    ['audio', 'video'].map(tracklist => {
      tracks[tracklist].forEach(track => {
        pcPartnerName.addTrack(track, screenStream); //should trigger negotiationneeded event
      });
    });
  } else if (!screenStream && myStream) {
    var tracks = {};
    tracks['audio'] = myStream.getAudioTracks();
    tracks['video'] = myStream.getVideoTracks();
    if (audioMuted || videoMuted) {
      var mutedStream = mutedStream ? mutedStream : h.getMutedStream();
      if (videoMuted) tracks['video'] = mutedStream.getVideoTracks();
      if (audioMuted) tracks['audio'] = mutedStream.getAudioTracks();
    }
    ['audio', 'video'].map(tracklist => {
      tracks[tracklist].forEach(track => {
        pcPartnerName.addTrack(track, myStream); //should trigger negotiationneeded event
      });
    });
  } else {
    h.getUserMedia()
      .then(stream => {
        //save my stream
        myStream = stream;
        h.addAudio(myStream);
        var mixstream = null;
        //provide access to window for debug
        if(h.canCreateMediaStream()){
          mixstream = new MediaStream();
        } else {
          //Safari trickery
          mixstream = myStream.clone();
          mixstream.getTracks().forEach(track=>{
            mixstream.removeTrack(track);
          });
        }
        window.myStream = myStream;
        window.mixstream = mixstream;
        var tracks = {};
        tracks['audio'] = myStream.getAudioTracks();
        tracks['video'] = myStream.getVideoTracks();
        if (audioMuted || videoMuted) {
          var mutedStream = mutedStream ? mutedStream : h.getMutedStream();
          if (videoMuted) tracks['video'] = mutedStream.getVideoTracks();
          if (audioMuted) tracks['audio'] = mutedStream.getAudioTracks();
        }
        ['audio', 'video'].map(tracklist => {
          tracks[tracklist].forEach(track => {
            mixstream.addTrack(track);
            pcPartnerName.addTrack(track, mixstream); //should trigger negotiationneeded event
          });
        });

        h.setVideoSrc(localVideo, mixstream);

	// SoundMeter for Local Stream
	if (myStream) {
  	    // Soundmeter
	    console.log('Init Soundmeter.........');
	    const slowMeter = document.getElementById('audiometer');
	    const soundMeter = window.soundMeter = new SoundMeter(window.audioContext);
 	    soundMeter.connectToSource(myStream).then(function() {
		setInterval(() => {
		      if(soundMeter.instant.toFixed(2) > 0.5) {
			console.log('Imm Speaking! Sending metadata mesh focus...');
			metaData.sentControlData({ username: username, id: socketId, talking: true});
		      } else {
			//metaData.sentControlData({ username: username, id: socketId, talking: false});
		      }
		      document.getElementById('audiometer').value = soundMeter.instant.toFixed(2) * 5;
		}, 1000);
	    });
  	}



      })
      .catch(async e => {
        console.error(`stream error: ${e}`);
        if (!enableHacks) return;
        // start crazy mode - lets offer anyway
        console.log("no media devices! offering receive only");
        var offerConstraints = {
          mandatory: { OfferToReceiveAudio: true, OfferToReceiveVideo: true }
        };
        let offer = await pcPartnerName.createOffer(offerConstraints);
        // SDP Interop
	// if (navigator.mozGetUserMedia) offer = Interop.toUnifiedPlan(offer);
        await pcPartnerName.setLocalDescription(offer);
        damSocket.out("sdp", {
          description: pcPartnerName.localDescription,
          to: partnerName,
          sender: socketId
        });
        // end crazy mode
      });
  }

  //create offer
  if (createOffer) {
    pcPartnerName.onnegotiationneeded = async () => {
      try {
        if (pcPartnerName.isNegotiating) {
          console.log(
            "negotiation needed with existing state?",
            partnerName,
            pcPartnerName.isNegotiating,
            pcPartnerName.signalingState
          );
          return; // Chrome nested negotiation bug
        }
        pcPartnerName.isNegotiating = true;
        let offer = await pcPartnerName.createOffer();
	// SDP Interop
	// if (navigator.mozGetUserMedia) offer = Interop.toUnifiedPlan(offer);
	// SDP Bitrate Hack
	// if (offer.sdp) offer.sdp = h.setMediaBitrate(offer.sdp, 'video', 500);

        await pcPartnerName.setLocalDescription(offer);
        damSocket.out("sdp", {
          description: pcPartnerName.localDescription,
          to: partnerName,
          sender: socketId
        });
      } finally {
        pcPartnerName.isNegotiating = false;
      }
    };
  }

  //send ice candidate to partnerNames
  pcPartnerName.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    damSocket.out("icecandidates", {
      candidate: candidate,
      to: partnerName,
      sender: socketId
    });
  };

  //add
  pcPartnerName.ontrack = e => {
    let str = e.streams[0];
    var el = document.getElementById(`${partnerName}-video`);
    if (el) {
      h.addAudio(str);
      h.setVideoSrc(el,str);
    } else {
      h.addVideo(partnerName, str);
    }
  };

  pcPartnerName.onconnectionstatechange = d => {
    console.log(
      "Connection State Change: " + partnerName,
      pcPartnerName.iceConnectionState
    );
    // Save State
    switch (pcPartnerName.iceConnectionState) {
      case "connected":
        sendMsg(
          partnerName + " is " + pcPartnerName.iceConnectionState,
          true
        );
	metaData.sentControlData({ username: username, id: socketId, online: true });
        break;
      case "disconnected":
        if (partnerName == socketId) {
          return;
        }
        sendMsg(
          partnerName + " is " + pcPartnerName.iceConnectionState,
          true
        );
        h.closeVideo(partnerName);
        // PC Tracking cleanup
        pcmap.get(partnerName).close();
        pcmap.delete(partnerName);
        break;
      case "new":
        /* why is new objserved when certain clients are disconnecting? */
        //h.closeVideo(partnerName);
        break;
      case "failed":
        if (partnerName == socketId) {
          return;
        } // retry catch needed
        break;
      case "closed":
        h.closeVideo(partnerName);
        break;
      default:
        console.log("Change of state: ", pcPartnerName.iceConnectionState);
        break;
    }
  };

  pcPartnerName.onsignalingstatechange = d => {
    console.log(
      "Signaling State Change: " + partnerName,
      pcPartnerName.signalingState
    );
    switch (pcPartnerName.signalingState) {
      case "stable":
        pcPartnerName.isNegotiating = false;
        break;
      case "closed":
        console.log("Signalling state is 'closed'");
	// Do we have a connection? If not kill the widget
	if (pcPartnerName.iceConnectionState !== "connected") h.closeVideo(partnerName);
        // Peers go down here and there - let's send a Subscribe, Just in case...
        damSocket.out("subscribe", {
          room: room,
          socketId: socketId,
          name: username || socketId
        });

        //h.closeVideo(partnerName);
        break;
    }
  };
}
