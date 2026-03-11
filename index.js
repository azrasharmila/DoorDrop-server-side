const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./doordrop-firebase-adminsdk.json");
const { cursorTo } = require('readline');
const { group } = require('console');
const { pipeline } = require('stream');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log('decoded in the token', decoded);
    req.decoded_email = decoded.email;
    next();
  }
  catch (err) {
    return res.status(401).send({ message: 'unauthorized access' })
  }


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.qnleitt.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {

    await client.connect();

    const db = client.db('door_drop_db');
    const parcelsCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');
    const userCollection = db.collection('users');
    const ridersCollection = db.collection('riders');
    const trackingsCollection = db.collection('trackings');
    const reviewsCollection = db.collection('reviews');


    console.log('MongoDB connected');

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    }
    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== 'rider') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    }



    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date()
      }
      const result = await trackingsCollection.insertOne(log);
      return result;
    }


    //user APIs

    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {

        query.$or = [
          { displayName: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } },
        ]

      }
      const cursor = userCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('users/:id', async (req, res) => {

    })

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email }
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || 'user' })
    })

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();
      const email = user.email;

      const userExists = await userCollection.findOne({ email })

      if (userExists) {
        return res.send({ message: 'user exists' })
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    })

    app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) }
      const updatedDoc = {
        $set: {
          role: roleInfo.role
        }
      }
      const result = await userCollection.updateOne(query, updatedDoc)
      res.send(result);
    })


    //parcel api

    app.get('/parcels', async (req, res) => {
      const query = {}
      const { email, deliveryStatus } = req.query;

      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;

      }

      const options = { sort: { createdAt: -1 } }


      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get('/parcels/rider', async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {}

      if (riderEmail) {
        query.riderEmail = riderEmail
      }
      if (deliveryStatus !== 'parcel_delivered') {
        //query.deliveryStatus = {$in: ['driver_assigned', 'rider_arriving']}
        query.deliveryStatus = { $nin: ['parcel_delivered','pending-pickup'] }
      }
      else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query)
      const result = await cursor.toArray();
      res.send(result);
    })


    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    })
    app.get('/parcels/delivery-status/stats', async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: '$deliveryStatus',
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            status: '$_id',
            count: 1
          }


        }
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });
    app.patch('/parcels/:id/status', async (req, res) => {
      console.log('Parcel ID:', req.params.id);
      console.log('Body:', req.body);
      const { deliveryStatus, riderId, trackingId } = req.body;

      const query = { _id: new ObjectId(req.params.id) }
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus
        }
      }
      if (deliveryStatus === 'parcel_delivered') {
        // update rider information
        const riderQuery = { _id: new ObjectId(riderId) }
        const riderUpdatedDoc = {
          $set: {
            workStatus: 'available'
          }
        }
        const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);
      }


      const result = await parcelsCollection.updateOne(query, updatedDoc)
      logTracking(trackingId, deliveryStatus);



      res.send(result);
    })


//for rider dash 
// Get parcel counts by status for a specific rider
app.get('/parcels/rider/status-counts', async (req, res) => {
  try {
    const riderEmail = req.query.riderEmail;
    if (!riderEmail) return res.status(400).send({ error: 'Rider email is required' });

    // Aggregate parcels by deliveryStatus
    const pipeline = [
      { $match: { riderEmail } },
      { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } }
    ];

    const counts = await parcelsCollection.aggregate(pipeline).toArray();

    // Map the counts to assigned / pending / delivered
    const assigned = counts.find(c => c._id === 'driver_assigned')?.count || 0;
    const pending = counts
      .filter(c => ['pending-pickup', 'in_delivery'].includes(c._id))
      .reduce((sum, c) => sum + c.count, 0);
    const delivered = counts.find(c => c._id === 'parcel_delivered')?.count || 0;

    res.send({ assigned, pending, delivered });

  } catch (error) {
    console.error('Error fetching rider parcel stats:', error);
    res.status(500).send({ error: 'Internal Server Error' });
  }
});



//finish
    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      //parcel created time
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;
      logTracking(trackingId, 'parcel_created');

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result)
    })
    app.patch('/parcels/:id', async (req, res) => {
      const { parcelId, riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const updatedDoc = {
        $set: {
          deliveryStatus: 'driver_assigned',
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail
        }
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc)
      const riderQuery = { _id: new ObjectId(riderId) }
      const riderUpdatedDoc = {
        $set: {
          workStatus: 'in_delivery'
        }
      }
      const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);


      logTracking(trackingId, 'driver_assigned')


      res.send(riderResult)

    })


    app.patch('/parcels/update/:id', async (req, res) => {
      const { id } = req.params;
      const updates = req.body;

      const allowedFields = [
        "receiverName",
        "receiverEmail",
        "receiverMobile",
        "receiverRegion",
        "receiverDistrict",
        "receiverAddress",
        "parcelWeight",
        "parcelType",
        "parcelName",
        "senderAddress",
        "senderMobile"
      ];

      const filteredUpdates = {};
      for (const key of Object.keys(updates)) {
        if (allowedFields.includes(key)) {
          filteredUpdates[key] = updates[key];
        }
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ error: "Invalid parcel ID" });
      }

      if (Object.keys(filteredUpdates).length === 0) {
        return res.status(400).send({ error: "No valid fields provided to update" });
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: filteredUpdates }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ error: "Parcel not found" });
        }

        res.send({ success: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error("Error updating parcel:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });



    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    })




    //Payment related APIs


    app.post('/payment-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.parcelName}`
              }
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        metadata: {
          parcelId: paymentInfo.parcelId,
          trackingId: paymentInfo.trackingId

        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      })

      res.send({ url: session.url })
    })

    //old

    // app.post('/create-checkout-session', async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;

    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: 'USD',
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName
    //           }
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     mode: 'payment',
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //       parcelName: paymentInfo.parcelName
    //     },
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   })

    //   console.log(session)
    //   res.send({ url: session.url })
    // })



    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      //console.log('session retrieve', session)
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId }

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {

        return res.send({
          message: 'already exists',
          transactionId,
          trackingId: paymentExist.trackingId
        })
      }
      // use the previous tracking id created during the parcel create which was set to the session metadata during session creation

      const trackingId = session.metadata.trackingId;

      if (session.payment_status === 'paid') {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) }
        const update = {
          $set: {
            paymentStatus: 'paid',
            deliveryStatus: 'pending-pickup',

          }
        }

        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId
        }


        const resultPayment = await paymentCollection.insertOne(payment)

        logTracking(trackingId, 'parcel_paid')


        return res.send({
          success: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment
        })


      }

      return res.send({ success: false })
    })


    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {}

      console.log('headers', req.headers);

      if (email) {
        query.customerEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' })
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    })


    //Riders APIs

    app.get('/riders', async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {}
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      console.log('query', query)
      const cursor = ridersCollection.find(query)
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get('/riders/delivery/per-day', async (req, res) => {

      const email = req.query.email;
      //aggerate on parcel
      const pipeline = [
        //  Filter parcels delivered by this rider
        {
          $match: {
            riderEmail: email,
            deliveryStatus: 'parcel_delivered'
          }
        },
        //  Join with trackings
        {
          $lookup: {
            from: 'trackings',
            localField: 'trackingId',
            foreignField: 'trackingId',
            as: 'parcel_trackings'
          }
        },
        // Flatten trackings array
        { $unwind: '$parcel_trackings' },
        // Only delivered trackings
        {
          $match: {
            'parcel_trackings.status': 'parcel_delivered'
          }
        },
        // 5️⃣ Group by day and count
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$parcel_trackings.createdAt" }
            },
            deliveredCount: { $sum: 1 }
          }
        },

      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result)


    })






    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.workStatus = 'available';
      rider.createdAt = new Date();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    })

    app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: 'available'
        }
      }

      const result = await ridersCollection.updateOne(query, updatedDoc);

      if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email }
        const updateUser = {
          $set: {
            role: 'rider'
          }
        }
        const userResult = await userCollection.updateOne(userQuery, updateUser);
      }

      res.send(result);
    })

    app.delete('/riders/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    })

    app.get('/trackings/:trackingId/logs', async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    })


    //Review

    app.post('/reviews', async (req, res) => {
      const review = req.body;
      review.email = req.decoded_email;
      review.createdAt = new Date();
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    app.get('/reviews', async (req, res) => {
      const cursor = reviewsCollection.find({}).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });



    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {


  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('doordrop is running')
})

app.listen(port, () => {
  console.log(`app listening on port ${port}`)
})