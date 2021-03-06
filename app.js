/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  quasData = require('./data/quas-data.js');

const kGetStartedButton = 'GET_STARTED';
const kHelp = 'HELP';
const kTasks = 'TASKS';
const kJoke = 'JOKE';

var Promise = require('promise');
var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {
    replyTextMessage(senderID, messageText);
  } 

  else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll check the payload and handle accordingly
  handlePayload(senderID, payload);
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  return callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",               
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",               
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",        
          timestamp: "1428444852", 
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Comedy",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
    return new Promise(function (resolve, reject) { // ***
        request({
            uri: 'https://graph.facebook.com/v2.6/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: messageData
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                var recipientId = body.recipient_id;
                var messageId = body.message_id;
                if (messageId) {
                    console.log("Successfully sent message with id %s to recipient %s", 
                                messageId, recipientId);
                } else {
                    console.log("Successfully called Send API for recipient %s", 
                                recipientId);
                }
                resolve(body); // ***
            } else {
                console.error("Failed calling Send API", response.statusCode,
                              response.statusMessage, body.error);
                reject(body.error); // ***
            }
        });
    });
}

/* --- This marks the beginning of Thawsitt's code. --- */

/*
 ===========================================================
                         USER INTERFACE
 ===========================================================
 */

/**
 * Function: showGreetingText
 * --------------------------
 * Sets the greeting text which is shown to new users. 
 *
 * Note: If you want to test this, delete the messages
 * and go to the app page again (https://m.me/quas.chat).
 */
function addGreetingText() {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { 
      access_token: PAGE_ACCESS_TOKEN,
    },
    method: 'POST',
    json: {
      setting_type: "greeting",
      greeting: {
        // Greeting text shown to the user
        text: "Hi {{user_first_name}}. Welcome to Quas!"
      }
    }
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      _log("Success: Greeting text set.");
     } else {
      _log('Setting greeting text FAILED.');
      console.error("Error in setting greeting text: ", response.statusCode, response.statusMessage, body.error);
    }
  });
}

/**
 * Function: removeGreetingText
 * ----------------------------
 * Removes the greeting text which is shown to new users.
 *
 * Note: This functions is currently not called anywhere. 
 * It is only here for completeness.
 */
function removeGreetingText() {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { 
      access_token: PAGE_ACCESS_TOKEN,
    },
    method: 'DELETE',
    json: {
      setting_type: "greeting"
    }
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      _log("Greeting text removed.")
     } else {
      _log('Setting greeting text FAILED.');
      console.error("Error in removing greeting text: ", response.statusCode, response.statusMessage, body.error);
    }
  });
}

/**
 * Function: showGetStartedButton
 * ------------------------------
 * Initializes "Get Started" button which is shown to new users. 
 *
 * Note: If you want to test this, delete the messages 
 * and go to the app page again (https://m.me/quas.chat).
 */
function addGetStartedButton() {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { 
      access_token: PAGE_ACCESS_TOKEN,
    },
    method: 'POST',
    json: {
      setting_type: "call_to_actions",
      thread_state: "new_thread",
      call_to_actions: [
        {
          "payload": kGetStartedButton
        }
      ]
    }
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      _log("Success: GET STARTED BUTTON set.");
     } else {
      _log('Cannot set GET STARTED BUTTON');
      console.error("Error in setting Get Started button: ", response.statusCode, response.statusMessage, body.error);
    }
  });
}

/**
 * Function: removeGetStartedButton
 * --------------------------------
 * Removes the "Get Started" button which is shown to new users.
 *
 * Note: This functions is currently not called anywhere. 
 * It is only here for completeness.
 */
function removeGetStartedButton() {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { 
      access_token: PAGE_ACCESS_TOKEN,
    },
    method: 'DELETE',
    json: {
      setting_type: "call_to_actions",
      thread_state: "new_thread"
    }
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      _log("Success: GET STARTED BUTTON removed.");
     } else {
      _log('Cannot remove GET STARTED BUTTON');
      console.error("Error in removing Get Started button: ", response.statusCode, response.statusMessage, body.error);
    }
  });
}


function addPersistentMenu(){
  request({
    url: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json:{
      setting_type : "call_to_actions",
      thread_state : "existing_thread",
      call_to_actions:[
      {
        type:"postback",
        title:"Help",
        payload: kHelp
      },
      {
        type:"postback",
        title:"My Tasks",
        payload: kTasks
      },
      {
        type:"postback",
        title:"Tell me a Joke",
        payload: kJoke
      },
      {
        type:"web_url",
        title:"Visit app page",
        url:"https://quas.herokuapp.com/"
      }
      ]
    }
  }, function(error, response, body) {
    //console.log(response)
    if (error) {
      console.log('Error adding persistent menu: ', error)
    } else if (response.body.error) {
      console.log('Error: ', response.body.error)
    } else {
      _log("Added Persistent Menu.");
    }
  });
}

function removePersistentMenu(){
  request({
    url: 'https://graph.facebook.com/v2.6/me/thread_settings',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'DELETE',
    json:{
      setting_type : "call_to_actions",
      thread_state : "existing_thread",
    }
  }, function(error, response, body) {
  //console.log(response)
    if (error) {
      console.log('Error sending messages: ', error)
    } else if (response.body.error) {
      console.log('Error: ', response.body.error)
    }
  });
}


/*
 ===========================================================
                     BOT FUNCTIONALITIES
 ===========================================================
 */

/**
 * Function: handlePayload
 * -----------------------
 * This function is called when a user sent a message with payload. 
 * (e.g: user pressed a button.) 
 * 
 * This function calls appropriate fuction based on the payload.
 */
function handlePayload(senderID, payload) {
  if (payload == kGetStartedButton) {
    showIntro(senderID);
  } 

  else {
    sendTextMessage(senderID, "Payload received.");
  }
}

/**
 * Function: showIntro
 * -------------------
 * Explains the user about Quas and its functions.
 *
 * This message is shown to new users when they press
 * 'Get Started' button, or to existing users when
 * they type 'info'.
 */
function showIntro(senderID) {
  var intro = quasData.intro_msg;
  getUserInfo(senderID)
  .then((body) => {
    var user_first_name = JSON.parse(body).first_name;
    if (user_first_name) {
      sendTextMessage(senderID, "Hi " + user_first_name + ". " + intro);
    } else {
      sendTextMessage(senderID, intro);
    }
  })
  .catch((err) => {
    sendTextMessage(senderID, intro);
    console.error("Cannot get user information: ", err);
  });
}

/**
 * Function: replyTextMessage
 * --------------------------
 * This function is called when a user sends a text message.
 * Checks the message and responds accordingly.
 * 
 * @param  {string} senderID    [Unique ID of the user]
 * @param  {string} messageText [Message sent by the user]
 */
function replyTextMessage(senderID, messageText) {

    // Checking if a user sent a greeting text (as defined in quas-data.js)
    // If that is the case, replies "Hi " + <user's firstname>
    if (quasData["hi"].indexOf(messageText.toLowerCase()) != -1) {
      greetUser(senderID);
    } 

    else {
      // If we receive a text message, check to see if it matches any special
      // keywords and send back the corresponding example. Otherwise, just echo
      // the text we received.
      switch (messageText.toLowerCase()) {
        case 'image':
          sendImageMessage(senderID);
          break;

        case 'gif':
          sendGifMessage(senderID);
          break;

        case 'audio':
          sendAudioMessage(senderID);
          break;

        case 'video':
          sendVideoMessage(senderID);
          break;

        case 'file':
          sendFileMessage(senderID);
          break;

        case 'button':
          sendButtonMessage(senderID);
          break;

        case 'generic':
          sendGenericMessage(senderID);
          break;

        case 'receipt':
          sendReceiptMessage(senderID);
          break;

        case 'quick reply':
          sendQuickReply(senderID);
          break;        

        case 'read receipt':
          sendReadReceipt(senderID);
          break;        

        case 'typing on':
          sendTypingOn(senderID);
          break;        

        case 'typing off':
          sendTypingOff(senderID);
          break;        

        case 'account linking':
          sendAccountLinking(senderID);
          break;

        /* my cases */

        case 'info':
          showIntro(senderID);
          break;

        case 'sync': // Send messages in order using Promise
          sendTextMessage(senderID, "1")
          .then(sendTextMessage.bind(null, senderID, "2")) // *** pass a function reference
          .then(sendTextMessage.bind(null, senderID, "3"))
          .then(sendTextMessage.bind(null, senderID, "4"))
          .then(sendTextMessage.bind(null, senderID, "5"))

          .catch(function (body) {
            _log('Sync test FAILED. Aborted');
          });
          break;

        default:
          sendTextMessage(senderID, messageText);
      }
    }  
}


/**
 * Function: greetUser
 * ---------------------
 * Replies "Hi " + <user's first name> + "!"
 * If user info request fails, just replies "Hello!".
 */
function greetUser(userID) {
  getUserInfo(userID)
  .then((body) => {
    var user_first_name = JSON.parse(body).first_name;
    if (user_first_name) {
      sendTextMessage(userID, "Hi " + user_first_name + "!"); 
    } else {
      sendTextMessage(userID, "Hello!");
    }
  })
  .catch((err) => {
    sendTextMessage(userID, "Hello!");
    console.error("Cannot get user information: ", err);
  });
}


/**
 * Function: GET USER INFO
 * -----------------------
 * Promise compatible function which returns a JSON representation
 * of user information (first name, last name, gender, locale, timezone) on success.
 */
function getUserInfo(senderID) {
  return new Promise(function (resolve, reject) { // ***
    request({
      uri: 'https://graph.facebook.com/v2.6/' + senderID,
      qs: { 
        access_token: PAGE_ACCESS_TOKEN,
    },
    method: 'GET',
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      _log("Get User Info SUCCESS.");
      // console.log(body); // left for debugging
      resolve(body); // *** user info JSON
      } else {
        _log("Get User Info FAILED.");
        console.error("Failed calling Send API", response.statusCode,
          response.statusMessage, body.error);
        reject(body.error); // ***
      }
    });
  });
}


/**
 * (helper) Function: _log
 * ------------------------
 * Makes an important message (log) easier to read
 * in the console.
 */
function _log(msg) {
  console.log('=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=');
  console.log(msg);
  console.log('=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=');
}


// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
  addGreetingText();
  addGetStartedButton();
  addPersistentMenu();
});

module.exports = app;

