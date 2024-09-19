const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);
const port = process.env.PORT || 5000;

const app = express();

app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.f1bhr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
	serverApi: {
		version: ServerApiVersion.v1,
		strict: true,
		deprecationErrors: true,
	},
});

async function run() {
	try {
		// Connect the client to the server	(optional starting in v4.7)
		await client.connect();

		const menuCollection = client.db("bistrobossDb").collection("menu");
		const reviewCollection = client.db("bistrobossDb").collection("reviews");
		const cartCollection = client.db("bistrobossDb").collection("carts");
		const usersCollection = client.db("bistrobossDb").collection("users");
		const paymentCollection = client.db("bistrobossDb").collection("payments");

		app.post("/jwt", (req, res) => {
			const user = req.body;
			const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
				expiresIn: "1h",
			});
			res.send({ token });
		});

		const verifyJWT = (req, res, next) => {
			const authHeader = req.headers.authorization;
			if (!authHeader) {
				return res.status(401).send({ message: "unauthorized access" });
			}
			const token = authHeader.split(" ")[1];
			jwt.verify(
				token,
				process.env.ACCESS_TOKEN_SECRET,
				function (err, decoded) {
					if (err) {
						return res.status(403).send({ message: "forbidden access" });
					}
					req.decoded = decoded;
					next();
				}
			);
		};

		const verifyAdmin = (req, res, next) => {
			const email = req.decoded.email;
			const query = { email: email };
			const user = usersCollection.findOne(query);
			const isAdmin = user?.role === "admin";

			if (isAdmin) {
				return res.status(403).send({ message: "forbidden access" });
			}
			next();
		};

		app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
			const result = await usersCollection.find().toArray();
			res.send(result);
		});

		app.post("/users", async (req, res) => {
			const user = req.body;
			const result = await usersCollection.insertOne(user);
			res.send(result);
		});

		app.get("/users/admin/:email", verifyJWT, async (req, res) => {
			const email = req.params.email;

			const decodedEmail = req.decoded.email;
			if (decodedEmail !== email) {
				return res.status(403).send({ message: "forbidden access" });
			}

			const query = { email: email };
			const user = await usersCollection.findOne(query);
			const result = { admin: user?.role === "admin" };
			res.send(result);
		});

		app.patch("/users/admin/:id", async (req, res) => {
			const id = req.params.id;
			const filter = { _id: new ObjectId(id) };
			const updateDoc = {
				$set: {
					role: "admin",
				},
			};
			const result = await usersCollection.updateOne(filter, updateDoc);
			res.send(result);
		});

		app.get("/menu", async (req, res) => {
			const result = await menuCollection.find().toArray();
			res.send(result);
		});

		app.post("/menu", verifyJWT, verifyAdmin, async (req, res) => {
			const newItem = req.body;
			const result = await menuCollection.insertOne(newItem);
			res.send(result);
		});

		app.delete("/menu/:id", verifyJWT, verifyAdmin, async (req, res) => {
			const id = req.params.id;
			const query = { _id: new ObjectId(id) };
			const result = await menuCollection.deleteOne(query);
			res.send(result);
		});

		app.get("/reviews", async (req, res) => {
			const result = await reviewCollection.find().toArray();
			res.send(result);
		});

		app.get("/carts", verifyJWT, async (req, res) => {
			let query = {};
			if (req.query.email) {
				query = {
					email: req.query.email,
				};
			}
			const decodedEmail = req.decoded.email;
			if (decodedEmail !== req.query.email) {
				return res.status(403).send({ message: "forbidden access" });
			}
			const result = await cartCollection.find(query).toArray();
			res.send(result);
		});

		app.post("/carts", async (req, res) => {
			const item = req.body;
			const result = await cartCollection.insertOne(item);
			res.send(result);
		});

		app.delete("/carts/:id", async (req, res) => {
			const id = req.params.id;
			const query = { _id: new ObjectId(id) };
			const result = await cartCollection.deleteOne(query);
			res.send(result);
		});

		app.post("/create-payment-intent", async (req, res) => {
			const { price } = req.body;
			const amount = parseInt(price * 100);
			const paymentIntent = await stripe.paymentIntents.create({
				amount: amount,
				currency: "usd",
				payment_method_types: ["card"],
			});
			res.send({ clientSecret: paymentIntent.client_secret });
		});

		app.get("/payments/:email", verifyJWT, async (req, res) => {
			const query = { email: req.params.email };
			if (req.params.email !== req.decoded.email) {
				return res.status(403).send({ message: "forbidden access" });
			}
			const result = await paymentCollection.find(query).toArray();
			res.send(result);
		});

		app.post("/payments", async (req, res) => {
			const payment = req.body;
			const paymentResult = await paymentCollection.insertOne(payment);
			const query = {
				_id: { $in: payment.cartIds.map((id) => new ObjectId(String(id))) },
			};
			const deleteResult = await cartCollection.deleteMany(query);

			res.send({ paymentResult, deleteResult });
		});

		app.get("/admin-stats", verifyJWT, verifyAdmin, async (req, res) => {
			const users = await usersCollection.estimatedDocumentCount();
			const menuItems = await menuCollection.estimatedDocumentCount();
			const orders = await paymentCollection.estimatedDocumentCount();
			const payments = await paymentCollection
				.aggregate([
					{
						$group: {
							_id: null,
							totalRevenue: { $sum: "$price" },
						},
					},
				])
				.toArray();

			const revenue = payments.length > 0 ? payments[0].totalRevenue : 0;

			res.send({
				users,
				menuItems,
				orders,
				revenue,
			});
		});

		app.get("/user-stats", verifyJWT, async (req, res) => {
			const orders = await paymentCollection.estimatedDocumentCount();
			const menu = await menuCollection.estimatedDocumentCount();
			const payment = await paymentCollection.estimatedDocumentCount();

			res.send({
				orders,
				menu,
				payment,
			});
		});

		app.get("/order-stats", verifyJWT, verifyAdmin, async (req, res) => {
			const pipeline = [
				{
					$unwind: "$menuItemIds",
				},
				{
					$lookup: {
						from: "menu",
						localField: "menuItemIds",
						foreignField: "_id",
						as: "menuItems",
					},
				},
				{
					$unwind: "$menuItems",
				},
				{
					$group: {
						_id: "$menuItems.category",
						count: { $sum: 1 },
						total: { $sum: "$menuItems.price" },
					},
				},
				{
					$project: {
						category: "$_id",
						count: 1,
						total: { $round: ["$total", 2] },
						_id: 0,
					},
				},
			];

			const result = await paymentCollection.aggregate(pipeline).toArray();
			res.send(result);
		});

		// Send a ping to confirm a successful connection
		await client.db("admin").command({ ping: 1 });
		console.log(
			"Pinged your deployment. You successfully connected to MongoDB!"
		);
	} finally {
		// Ensures that the client will close when you finish/error
		// await client.close();
	}
}
run().catch(console.dir);

app.get("/", (req, res) => {
	res.send("Hello World!");
});

app.listen(port, () => {
	console.log(`Example app listening at http://localhost:${port}`);
});
