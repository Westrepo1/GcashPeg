// verify-all-users.js
const mongoose = require('mongoose');
const User = require('./server/Models/User'); // Adjust path if needed

// Your MongoDB connection string (same as in app.js)
const db = 'mongodb+srv://marcelpolocha1:081358pius@cluster0.f9a85hv.mongodb.net/gcashPro';

async function verifyAllUsers() {
  try {
    // Connect to MongoDB
    await mongoose.connect(db, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Update ALL users: set isVerified = true
    const result = await User.updateMany(
      {}, // Empty filter = match all documents
      {
        $set: {
          isVerified: true,
          verificationToken: null,
          verificationTokenExpires: null,
        },
      }
    );

    console.log(`Success! Updated ${result.modifiedCount} users.`);
    console.log(`Matched ${result.matchedCount} users in total.`);

    // Optional: Show a few examples
    const sampleUsers = await User.find({}).select('email isVerified').limit(5);
    console.log('\nSample users after update:');
    sampleUsers.forEach(u => console.log(`→ ${u.email} | Verified: ${u.isVerified}`));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    // Close connection
    await mongoose.connection.close();
    console.log('Database connection closed.');
    process.exit(0);
  }
}

// Run the script
verifyAllUsers();