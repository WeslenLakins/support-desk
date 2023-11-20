const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const Subscription = require("../models/subscriptionModel");
const PaymentLog = require("../models/paymentLogModel");
const { changeUnixTimestampFormat } = require("../common");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const handleCreateSubscription = async (subData, subscriptionType) => {
  return await Subscription.create({
    userId: subData.metadata.userId,
    subscriptionId: subData.id,
    subscriptionStatus: subData.status,
    startDate: changeUnixTimestampFormat(subData.created),
    endDate: changeUnixTimestampFormat(subData.current_period_end),
    paymentStatus: "complete",
    subscriptionType: subscriptionType,
    customerId: subData.customer,
    priceId: subData.metadata.priceId,
  });
};

// @desc:     create checkout session for subscription payment.
// @route:    /api/subscription
// @access:   Private
const createCheckoutSession = asyncHandler(async (req, res) => {
  const params = req.body;
  const type = params.type ? params.type : "";
  const successUrl = params.successUrl ? params.successUrl : "";
  const cancelUrl = params.cancelUrl ? params.cancelUrl : "";

  if (!successUrl || !cancelUrl) {
    res.status(400);
    throw new Error("Please pass required all parameters.");
  }
  if (type && type !== "trial") {
    res.status(400);
    throw new Error("Please pass valid type");
  }

  const { _id } = req.user;
  const user = await User.findById(_id);
  if (!user) {
    res.status(401);
    throw new Error("User not found.");
  }

  const activeSub = await Subscription.findOne({
    $and: [
      { userId: _id },
      {
        $or: [
          { subscriptionStatus: "active" },
          { subscriptionStatus: "trialing" },
        ],
      },
      { endDate: { $gte: new Date() } },
    ],
  }).select({ _id: 1 });

  if (activeSub) {
    res.status(401);
    throw new Error("Subscription already exist.");
  }

  const products = await stripe.products.list();
  if (products && products.data.length > 0) {
    const reqObj = {
      price: products.data[0].default_price,
      quantity: 1,
    };
    const payment = await PaymentLog.create({
      userId: _id,
      request: reqObj,
    });
    const metaDataObj = {
      paymentLog: payment._id.toString(),
      userId: _id.toString(),
      priceId: products.data[0].default_price,
    };
    const subscription_data = {
      metadata: metaDataObj,
    };
    if (type === "trial") {
      subscription_data.trial_settings = {
        end_behavior: {
          missing_payment_method: "cancel",
        },
      };
      subscription_data.trial_period_days = 3;
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [reqObj],
      mode: "subscription",
      subscription_data,
      metadata: metaDataObj,
      success_url: `${successUrl}`,
      cancel_url: `${cancelUrl}?id=${payment._id.toString()}`,
    });

    res.status(200).json({ url: session.url });
  } else {
    res.status(401);
    throw new Error("Plan not found.");
  }
});

// @desc:     handle stripe webhook.
// @route:    /api/subscription/webhook
// @access:   Private
const webHook = asyncHandler(async (req, res) => {
  const params = req.body;
  const { type, data } = params;
  console.log("type===============>", type);
  const createObj = {
    response: params,
    status:
      data.object && data.object.status ? data.object.status : "NO-STATUS",
    event: type,
  };

  //get userId inside metaData object
  if (
    type === "invoice.payment_succeeded" ||
    type === "invoice.updated" ||
    type === "invoice.created"
  ) {
    createObj.userId = data.object.subscription_details.userId;
  } else if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "checkout.session.completed" ||
    type === "payment_intent.succeeded" ||
    type === "payment_intent.created"
  ) {
    createObj.userId = data.object.metadata.userId;
  }

  //add data in paymentLog table
  if (type !== "charge.succeeded" && type !== "payment_method.attached") {
    await PaymentLog.create(createObj);
  }

  //add data in subscription table when create subscription
  if (type === "customer.subscription.created") {
    const subData = data.object;
    await handleCreateSubscription(subData, subData.status);
  }
  if (type === "customer.subscription.updated") {
    const subData = data.object;
    const sub = await Subscription.findOne({
      subscriptionId: subData.id,
      subscriptionStatus: "incomplete",
    });
    if (sub) {
      await Subscription.updateOne(
        { _id: sub._id },
        {
          subscriptionStatus: "active",
          subscriptionType: "new",
        }
      );
    } else {
      //check condition when call subscription update event for renewal subscription not a cancel
      if (!subData.cancel_at_period_end) {
        await handleCreateSubscription(subData, "renewal");
        await PaymentLog.updateOne(
          { _id: data.object.metadata.paymentLog },
          {
            response: params,
            status:
              data.object.status === "active" ? "success" : data.object.status,
            event: type,
          }
        );
      }
    }
  }
  res.status(200).json();
});

// @desc:     handle cancel payment.
// @route:    /api/subscription/cancel-payment
// @access:   Private
const cancelPayment = asyncHandler(async (req, res) => {
  const params = req.body;
  const paymentId = params.paymentId ? params.paymentId : "";

  if (!paymentId) {
    res.status(400);
    throw new Error("Please pass required all parameters.");
  }
  await PaymentLog.updateOne(
    {
      _id: paymentId,
    },
    { status: "cancel", event: "cancel" }
  );
  res.status(200).json({ success: true });
});

// @desc:     handle cancel subscription
// @route:    /api/subscription/cancel
// @access:   Private
const cancelSubscription = asyncHandler(async (req, res) => {
  const params = req.body;
  const subscriptionId = params.subscriptionId ? params.subscriptionId : "";

  if (!subscriptionId) {
    res.status(400);
    throw new Error("Please pass required all parameters.");
  }
  const sub = await Subscription.findOne({
    $and: [
      { userId: req.user._id },
      { subscriptionId: subscriptionId },
      {
        $or: [
          { subscriptionStatus: "active" },
          { subscriptionStatus: "trialing" },
        ],
      },
      { endDate: { $gte: new Date() } },
    ],
  });
  if (!sub) {
    res.status(400);
    throw new Error("Subscription does not exist.");
  }

  //end subscription recurring cycle for cancel subscription
  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  res.status(200).json({ success: true });
});

module.exports = {
  createCheckoutSession,
  webHook,
  cancelPayment,
  cancelSubscription,
};
