const express = require('express')
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
let parcelsCollection;
let paymentCollection;
let userCollection;
let ridersCollection;

async function run() {
  try {

    await client.connect();

    const db = client.db('door_drop_db');
     parcelsCollection = db.collection('parcels');
    paymentCollection = db.collection('payments');
    userCollection = db.collection('users');
    ridersCollection = db.collection('riders');

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
// Backend: server/routes/parcels.js (or wherever your routes are)
app.get('/parcels/rider', async (req, res) => {
   console.log(req.query);
  try {
    const { riderEmail, deliveryStatus } = req.query;

    // 1️⃣ Validate query parameters
    if (!riderEmail || !deliveryStatus) {
      return res.status(400).json({ error: 'Missing query parameters: riderEmail and deliveryStatus are required' });
    }

    // 2️⃣ Build the query safely
    const query = {
      riderEmail: riderEmail,
      deliveryStatus: deliveryStatus
    };

    // 3️⃣ Fetch from MongoDB
    const parcels = await parcelsCollection.find(query).toArray();

    // 4️⃣ Return results
    return res.status(200).json(parcels);

  } catch (error) {
    // 5️⃣ Catch any unexpected errors
    console.error('Error fetching parcels for rider:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
    

   app.get('/parcels/:id', async (req, res) => {
  const id = req.params.id;

  // 1️⃣ Validate ID
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid parcel ID' });
  }

  try {
    // 2️⃣ Safe database query
    const query = { _id: new ObjectId(id) };
    const result = await parcelsCollection.findOne(query);

    // 3️⃣ Handle not found
    if (!result) {
      return res.status(404).json({ error: 'Parcel not found' });
    }

    // 4️⃣ Return result
    res.json(result);

  } catch (error) {
    // 5️⃣ Catch unexpected errors
    console.error('Error fetching parcel by ID:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});




    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result)
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
app.patch('/parcels/:id', async (req, res) => {
      const {parcelId,riderId,riderName,riderEmail } = req.body;
      const id=req.params.id;
      const query={_id:new ObjectId(id)}

      const updatedDoc={
        $set: {
          deliveryStatus:'driver_assigned',
          riderId: riderId,
          riderName: riderName,
          riderEmail:riderEmail
        }
      }
      const result= await parcelsCollection.updateOne(query,updatedDoc)
            const riderQuery={_id:new ObjectId(id)}
            const riderUpdatedDoc={
              $set:{
                workStatus:'in_delivery'
              }
            }
            const riderResult=await ridersCollection.updateOne(riderQuery,riderUpdatedDoc);
            res.send(riderResult)

})
      


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
          parcelId: paymentInfo.parcelId
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      })

      res.send({ url: session.url })
    })



    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName
              }
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      })

      console.log(session)
      res.send({ url: session.url })
    })



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

      const trackingId = generateTrackingId()

      if (session.payment_status === 'paid') {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) }
        const update = {
          $set: {
            paymentStatus: 'paid',
            deliveryStatus: 'pending-pickup',
            trackingId: trackingId
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

        if (session.payment_status === 'paid') {
          const resultPayment = await paymentCollection.insertOne(payment)

          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment
          })
        }

      }

      res.send({ success: false })
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
        query.workStatus = workStatus
      }

      const cursor = ridersCollection.find(query)
      const result = await cursor.toArray();
      res.send(result);
    })

    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    })


    app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
     
      const id = req.params.id;
      const { status, workStatus } = req.body;
      const query = { _id: new ObjectId(id) }
      const updatedDoc = { $set: { status: status } };
  if (workStatus) updatedDoc.$set.workStatus = workStatus; 
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