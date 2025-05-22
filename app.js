const express = require('express');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const session = require('express-session');
const flash = require('connect-flash');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('./server/Models/User');
const SendMoney = require('./server/Models/sendMoney');

const app = express();
const PORT = process.env.PORT || 6500;

// Middlewares (unchanged from your provided app.js)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  useTempFiles: true,
  tempFileDir: 'public/uploads',
}));
app.use(methodOverride('_method'));
app.use(session({
  secret: 'piuscandothis',
  resave: false,
  saveUninitialized: false,
}));
app.use(flash());

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// DB config
const db = 'mongodb+srv://pius1:pius123@webdevelopment.xav1dsx.mongodb.net/gcashPro';
mongoose.connect(db)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

// Middleware to pass flash messages to views
app.use((req, res, next) => {
  res.locals.messages = req.flash();
  next();
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.jwt;
  if (token) {
    jwt.verify(token, 'piuscandothis', (err, decodedToken) => {
      if (err) {
        console.log(err.message);
        res.redirect('/login');
      } else {
        req.userId = decodedToken.id;
        next();
      }
    });
  } else {
    res.redirect('/login');
  }
};

// Unified handleErrors function (unchanged)
const handleErrors = (err) => {
  let errors = {
    first_name: '',
    last_name: '',
    email: '',
    password: '',
    code: '',
  };

  if (err.code === 11000) {
    if (err.keyPattern.email) {
      errors.email = 'That email is already registered';
    } else if (err.keyPattern.accNo) {
      errors.accNo = 'Account number already exists';
    }
    return errors;
  }

  if (err.message.includes('user validation failed')) {
    Object.values(err.errors).forEach(({ properties }) => {
      errors[properties.path] = properties.message;
    });
    return errors;
  }

  if (err.message === 'Incorrect email') {
    errors.email = 'Incorrect email';
  } else if (err.message === 'Incorrect password') {
    errors.password = 'Incorrect password';
  } else if (err.message === 'Your account is not verified. Please verify it or create another account.') {
    errors.email = err.message;
  } else if (err.message === 'Your account is suspended. If you believe this is a mistake, please contact support') {
    errors.email = err.message;
  } else if (err.message === 'All fields are required') {
    errors.first_name = 'All fields are required';
  } else if (err.message === 'Passwords do not match') {
    errors.password = 'Passwords do not match';
  } else if (err.message === 'Invalid or expired verification code') {
    errors.code = 'Invalid or expired verification code';
  }

  return errors;
};

// JWT token creation
const maxAge = 3 * 24 * 60 * 60;
const createToken = (id) => {
  return jwt.sign({ id }, 'piuscandothis', { expiresIn: maxAge });
};

// Send verification email (unchanged)
const sendVerificationEmail = async (email, code) => {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'piuspolocha1231@gmail.com',
      pass: 'nrdjzywfmarvykez',
    },
  });

  const mailOptions = {
    from: 'piuspolocha1231@gmail.com',
    to: email,
    subject: 'Email Verification Code',
    html: `<p>Your verification code is: <strong>${code}</strong><br>Please enter this code to verify your account.</p>`,
  };

  await transporter.sendMail(mailOptions);
};

// Generate account number (unchanged)
const generateAccountNumber = () => {
  const prefix = '557335';
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${randomDigits}`;
};

// Routes (existing routes unchanged, adding /api/transactions)
app.get('/', (req, res) => {
  res.render('login');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      throw Error('All fields are required');
    }

    const user = await User.login(email, password);
    const token = createToken(user._id);
    res.cookie('jwt', token, { httpOnly: true, maxAge: maxAge * 1000 });

    res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        accNo: user.accNo,
        balance: user.balance,
      },
    });
  } catch (err) {
    const errors = handleErrors(err);
    res.status(400).json({ errors });
  }
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { first_name, last_name, email, password1, password2 } = req.body;

  try {
    if (!first_name || !last_name || !email || !password1 || !password2) {
      throw Error('All fields are required');
    }

    if (password1 !== password2) {
      throw Error('Passwords do not match');
    }

    const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    let accNo;
    let isUnique = false;

    while (!isUnique) {
      accNo = generateAccountNumber();
      const existingUser = await User.findOne({ accNo });
      if (!existingUser) {
        isUnique = true;
      }
    }

    const user = new User({
      first_name,
      last_name,
      email,
      password: password1,
      verificationCode,
      accNo,
    });

    const savedUser = await user.save();
    await sendVerificationEmail(email, verificationCode);
    req.session.pendingUserId = savedUser._id;

    res.status(201).json({ success: true, redirect: '/verify-email' });
  } catch (err) {
    const errors = handleErrors(err);
    console.error('Registration error:', { message: err.message, errors });
    res.status(400).json({ success: false, errors });
  }
});

app.get('/verify-email', (req, res) => {
  if (!req.session.pendingUserId) {
    return res.redirect('/signup');
  }
  res.render('verify-email');
});

app.post('/verify-email', async (req, res) => {
  const { code } = req.body;
  const pendingUserId = req.session.pendingUserId;

  try {
    if (!pendingUserId) {
      throw Error('No pending user found');
    }

    const user = await User.findById(pendingUserId);
    if (!user) {
      throw Error('User not found');
    }

    if (user.verificationCode !== code) {
      throw Error('Invalid or expired verification code');
    }

    user.isVerified = true;
    user.verificationCode = null;
    await user.save();

    const token = createToken(user._id);
    res.cookie('jwt', token, { httpOnly: true, maxAge: maxAge * 1000 });
    delete req.session.pendingUserId;

    res.status(200).json({
      success: true,
      redirect: '/dashboard',
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        accNo: user.accNo,
        balance: user.balance,
      },
    });
  } catch (err) {
    const errors = handleErrors(err);
    res.status(400).json({ success: false, errors });
  }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -verificationCode -otp -otpExpires');
    if (!user) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
    res.render('dashboard', { user });
  } catch (err) {
    console.error(err);
    res.redirect('/login');
  }
});

app.get('/api/user', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -verificationCode -otp -otpExpires');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        accNo: user.accNo,
        balance: user.balance,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});



app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    // Validate req.userId
    if (!mongoose.Types.ObjectId.isValid(req.userId)) {
      console.error('Invalid userId:', req.userId);
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    // Fetch sender
    const sender = await User.findById(req.userId).lean();
    if (!sender) {
      console.error('User not found for userId:', req.userId);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Fetch transactions
    const transactions = await SendMoney.find({
      $or: [
        { owner: req.userId }, // User is the sender
        { recipient_account: sender.accNo || '' }, // User is the recipient
      ],
    }).sort({ createdAt: -1 }).lean();

    // Map transactions to include sender and recipient names
    const transactionDetails = await Promise.all(
      transactions.map(async (transaction) => {
        let senderName = sender.first_name && sender.last_name
          ? `${sender.first_name} ${sender.last_name}`
          : 'Unknown Sender';
        let recipientName;

        // If user is the sender
        if (transaction.owner && transaction.owner.toString() === req.userId.toString()) {
          if (transaction.recipient_name) {
            // Use stored recipient_name for non-registered accounts
            recipientName = transaction.recipient_name;
          } else {
            // Fetch recipient's name
            const recipient = await User.findOne({ accNo: transaction.recipient_account }).lean();
            recipientName = recipient && recipient.first_name && recipient.last_name
              ? `${recipient.first_name} ${recipient.last_name}`
              : 'Unknown Recipient';
          }
        } else {
          // User is the recipient, so sender is the owner
          const owner = transaction.owner && mongoose.Types.ObjectId.isValid(transaction.owner)
            ? await User.findById(transaction.owner).lean()
            : null;
          senderName = owner && owner.first_name && owner.last_name
            ? `${owner.first_name} ${owner.last_name}`
            : 'Unknown Sender';
          recipientName = senderName; // Current user
        }

        return {
          id: transaction._id,
          senderAccountNumber: transaction.from || '',
          recipientAccountNumber: transaction.recipient_account || '',
          senderName,
          recipientName,
          amount: transaction.amount || 0,
          date: transaction.createdAt || new Date(),
          note: transaction.note || '',
        };
      })
    );

    res.status(200).json({
      success: true,
      transactions: transactionDetails,
    });
  } catch (err) {
    console.error('Error in /api/transactions:', {
      message: err.message,
      stack: err.stack,
      userId: req.userId,
    });
    res.status(500).json({ success: false, message: 'Error fetching transactions' });
  }
});

app.get('/send-money', requireAuth, async(req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
          return res.redirect('/login');
        }
        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000); // 6-digit OTP
        const otpExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        user.otp = otp;
        user.otpExpires = otpExpires;
        await user.save();
        // Send OTP via email
        // await sendVerificationEmail(user.email, otp); // Modify to send OTP
        res.render('send-money');
      } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
      }
  });
  
  app.post('/send-money', requireAuth, async (req, res) => {
    const { recipient_account, amount, note, recipient_name } = req.body;
  
    try {
      if (!recipient_account || !amount) {
        throw Error('Recipient account and amount are required');
      }
  
      const sender = await User.findById(req.userId);
      if (!sender) {
        throw Error('Sender not found');
      }
  
      if (sender.balance < amount) {
        throw Error('Insufficient balance');
      }
  
      let recipient = await User.findOne({ accNo: recipient_account });
      let isRecipientNotFound = false;
  
      if (!recipient) {
        // If recipient not found, check if recipient_name is provided
        if (!recipient_name || typeof recipient_name !== 'string' || recipient_name.trim() === '') {
          throw Error('Recipient name is required for non-registered accounts');
        }
        isRecipientNotFound = true;
      }
  
      // Update sender's balance
      sender.balance -= amount;
      await sender.save();
  
      // Update recipient's balance only if recipient is found
      if (!isRecipientNotFound) {
        recipient.balance += amount;
        await recipient.save();
      }
  
      // Create transaction
      const transaction = new SendMoney({
        from: sender.accNo,
        recipient_account,
        amount,
        note,
        owner: sender._id,
        recipient_name: isRecipientNotFound ? recipient_name.trim() : null, // Store recipient_name if not found
      });
      await transaction.save();
  
      // Prepare transaction details for response
      const transactionDetails = {
        id: transaction._id,
        senderAccountNumber: sender.accNo,
        recipientAccountNumber: recipient_account,
        senderName: `${sender.first_name} ${sender.last_name}`,
        recipientName: isRecipientNotFound
          ? recipient_name.trim()
          : `${recipient.first_name} ${recipient.last_name}`,
        amount: amount,
        date: transaction.createdAt,
        note: note,
      };
  
      // Return transaction details
      res.status(200).json({
        success: true,
        redirect: '/confirmation',
        transaction: transactionDetails,
      });
    } catch (err) {
      const errors = handleErrors(err);
      res.status(400).json({ success: false, errors });
    }
  });
  
  // New endpoint to fetch user by account number
  app.get('/api/user/:accNo', requireAuth, async (req, res) => {
    try {
      const user = await User.findOne({ accNo: req.params.accNo }).select('first_name last_name accNo');
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.status(200).json({
        success: true,
        user: {
          accountNumber: user.accNo,
          name: `${user.first_name} ${user.last_name}`,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });
  
  // Updated /api/validate-otp endpoint
app.post('/api/validate-otp', requireAuth, async (req, res) => {
    const { otp } = req.body;
  
    try {
      if (!otp) {
        throw Error('OTP is required');
      }
  
      const user = await User.findById(req.userId);
      if (!user) {
        throw Error('User not found');
      }
  
      // Convert input OTP to number for comparison
      const inputOtp = Number(otp);
  
      // Check if OTP exists, matches, and is not expired
      if (
        user.otp === null ||
        user.otpExpires === null ||
        user.otp !== inputOtp ||
        new Date() > new Date(user.otpExpires)
      ) {
        throw Error('Invalid or expired OTP');
      }
  
      // Clear OTP fields after successful validation
      user.otp = null;
      user.otpExpires = null;
      await user.save();
  
      res.status(200).json({ success: true });
    } catch (err) {
      const errors = handleErrors(err);
      res.status(400).json({ success: false, errors });
    }
  });

  app.get("/confirmation",(req,res)=>{
    res.render("confirmation")
  })
  
  app.get('/api/transactions', requireAuth, async (req, res) => {
    try {
      const sender = await User.findById(req.userId);
      if (!sender) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
  
      // Fetch transactions where the user is either the sender or recipient
      const transactions = await SendMoney.find({
        $or: [
          { owner: req.userId }, // User is the sender
          { recipient_account: sender.accNo }, // User is the recipient
        ],
      }).sort({ createdAt: -1 }); // Sort by newest first
  
      // Map transactions to include sender and recipient names
      const transactionDetails = await Promise.all(
        transactions.map(async (transaction) => {
          let senderName = `${sender.first_name} ${sender.last_name}`; // Default to current user
          let recipientName;
  
          // If user is the sender
          if (transaction.owner.toString() === req.userId.toString()) {
            if (transaction.recipient_name) {
              // Use stored recipient_name for non-registered accounts
              recipientName = transaction.recipient_name;
            } else {
              // Fetch recipient's name
              const recipient = await User.findOne({ accNo: transaction.recipient_account });
              recipientName = recipient
                ? `${recipient.first_name} ${recipient.last_name}`
                : 'Unknown';
            }
          } else {
            // User is the recipient, so sender is the owner
            const owner = await User.findById(transaction.owner);
            senderName = owner
              ? `${owner.first_name} ${owner.last_name}`
              : 'Unknown';
            recipientName = `${sender.first_name} ${sender.last_name}`; // Current user
          }
  
          return {
            id: transaction._id,
            senderAccountNumber: transaction.from,
            recipientAccountNumber: transaction.recipient_account,
            senderName,
            recipientName,
            amount: transaction.amount,
            date: transaction.createdAt,
            note: transaction.note,
          };
        })
      );
  
      res.status(200).json({
        success: true,
        transactions: transactionDetails,
      });
    } catch (err) {
      console.error('Error fetching transactions:', err);
      res.status(500).json({ success: false, message: 'Error fetching transactions' });
    }
  });

  app.get('/transactions/:userId', requireAuth, async (req, res) => {
    try {
      const user = await User.findById(req.params.userId).select('-password -verificationCode -otp -otpExpires').lean();
      if (!user) {
        return res.redirect('/login');
      }
  
      // Sanitize user object for frontend
      const sanitizedUser = {
        _id: user._id.toString(),
        accNo: user.accNo || '',
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        balance: typeof user.balance === 'number' ? user.balance : 0, // Ensure balance is a number
      };
  
      res.render('transactions', { user: sanitizedUser });
    } catch (err) {
      console.error(err);
      res.redirect('/dashboard');
    }
  });

app.get('/logout', (req, res) => {
    res.clearCookie('jwt');
    res.redirect('/login');
  });

// admin Routesand codes

app.get("/siteAdminPages", async(req, res)=>{
    let perPage = 100; // Number of users per page
    let page = parseInt(req.query.page) || 1; // Current page
    let sort = req.query.sort || 'createdAt'; // Default sort field
    let order = req.query.order || 'desc'; // Default sort order
    let status = req.query.status || 'all'; // Default status filter
  
    try {
      // Build query for filtering
      let query = {};
      if (status === 'active') {
        query.isSuspended = false; // Active users
      } else if (status === 'suspended') {
        query.isSuspended = true; // Suspended users
      } // No filter for 'all'
  
      // Map sort fields to schema fields
      let sortField = sort;
      if (sort === 'fullname') {
        sortField = 'first_name'; // Sort by first_name (fullname handled in $addFields)
      } else if (sort === 'tel') {
        sortField = 'phone'; // Map tel to phone
      } else if (sort === 'index') {
        sortField = 'createdAt'; // Fallback for index (client-side numbering)
      }
  
      // Query users with pagination, filtering, and sorting
      const user = await User.aggregate([
        {
          $addFields: {
            fullname: { $concat: ['$first_name', ' ', '$last_name'] }, // Create fullname
            tel: '$phone', // Alias phone as tel
          },
        },
        { $match: query }, // Apply status filter
        { $sort: { [sortField]: order === 'asc' ? 1 : -1 } }, // Apply sorting
      ])
        .skip(perPage * (page - 1)) // Pagination: skip previous pages
        .limit(perPage) // Pagination: limit to perPage
        .exec();
  
      // Count total users for pagination
      const count = await User.countDocuments(query);
  
      res.render("adminDashboard", {
        user, // Array of users
        page, // Current page
        totalPages: Math.ceil(count / perPage), // Total pages
        sort,
        order,
        status,
      });
    } catch (error) {
      console.log(error);
      res.render("adminDashboard", {
        user: [], // Empty array on error
        page: 1,
        totalPages: 1,
        sort: 'createdAt',
        order: 'desc',
        status: 'all',
      });
    }
})

app.get("/viewUser/:id",async(req, res)=>{
    try {
        const user = await User.findOne({ _id: req.params.id })
          .populate('sendMoneys') // Populate SendMoney details
          .lean(); // Convert to plain JS object for manipulation
    
        if (!user) {
          return res.status(404).render('error', { message: 'User not found' });
        }
    
        // Derive fullname and tel
        user.fullname = `${user.first_name} ${user.last_name}`;
    
        res.render('viewUser', {
          user,
        });
      } catch (error) {
        console.error(error);
        res.status(500).render('error', { message: 'An error occurred while fetching user details' });
      }
})

app.get("/editUser/:id",async(req, res)=>{
    try {
        const user = await User.findOne({ _id: req.params.id }).lean();
    
        if (!user) {
          return res.status(404).render('error', { message: 'User not found' });
        }
    
        // Derive fullname and tel
        user.fullname = `${user.first_name} ${user.last_name}`;
    
        res.render('editUser', {
          user,
        });
      } catch (error) {
        console.error(error);
        res.status(500).render('error', { message: 'An error occurred while fetching user details' });
      }
})

app.put("/editUser/:id", async (req, res) => {
    try {
      const { balance } = req.body;
  
      // Validate balance
      if (!balance || isNaN(balance) || parseFloat(balance) < 0) {
        return res.status(400).render('editUser', {
          user: await User.findOne({ _id: req.params.id }).lean(),
          error: 'Balance must be a non-negative number',
        });
      }
  
      // Update user balance
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { balance: parseFloat(balance) },
        { new: true, runValidators: true }
      );
  
      if (!user) {
        return res.status(404).render('error', { message: 'User not found' });
      }
  
      // Derive fullname for re-rendering
      user.fullname = `${user.first_name} ${user.last_name}`;
  
      // Redirect to viewUser or re-render with success message
      res.redirect(`/viewUser/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.status(500).render('editUser', {
        user: await User.findOne({ _id: req.params.id }).lean(),
        error: 'An error occurred while updating the user',
      });
    }
  });


// Email function for suspension notification
const sendSuspensionEmail = async (fullname, email, isSuspended) => {
    try {
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true, // Use SSL
          auth: {
              user: 'piuspolocha1231@gmail.com', // Replace with your Gmail address
              pass: 'nrdjzywfmarvykez'     // Replace with your Gmail App Password
          }
        });
        const status = isSuspended ? 'suspended' : 'reactivated';
        const mailOptions = {
            from: 'piuspolocha1231@gmail.com',
            to: email,
            subject: `Account ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            html: `<p>Hello ${fullname},<br>Your account has been ${status}.<br>${
                isSuspended
                    ? 'If you believe this is a mistake, please contact support at support@vitacoininvestments.com.'
                    : 'You can now log in and access all features.'
            }<br>You can login here: https://vitacoininvestments.com/login.<br>Thank you.</p>`
        };
        await transporter.sendMail(mailOptions);
        console.log('Suspension email sent');
    } catch (error) {
        console.error('Error sending suspension email:', error.message);
    }
  };

app.post("/suspendUser/:id",async(req,res)=>{
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            req.flash('error', 'User not found');
            return res.redirect('/siteAdminPages');
        }
  
        // Toggle suspension status
        user.isSuspended = !user.isSuspended;
        await user.save();
  
        // Send email notification
        await sendSuspensionEmail(user.fullname, user.email, user.isSuspended);
  
        req.flash('success', `User ${user.isSuspended ? 'suspended' : 'reactivated'} successfully`);
        res.redirect('/siteAdminPage');
    } catch (error) {
        console.error('Error in suspendUser:', error);
        req.flash('error', 'Error updating user suspension status');
        res.redirect('/siteAdminPages');
    }
})

app.delete("/deleteUser/:id",async(req, res)=>{
    try {
        await User.deleteOne({ _id: req.params.id });
          res.redirect("/siteAdminPages")
        } catch (error) {
          console.log(error);
        }
})


app.listen(PORT, () => console.log(`Server running on ${PORT}`));